// A structural walker over one zstd frame (RFC 8878 sections 3.1.1, 3.1.1.1 and 3.1.1.2), placed in front of Node's
// decompressor because zstd versions differ on a cut frame (Node 24.13.0 decompresses it without any error, 24.22.1
// fails it; MEMORY.md, Phase 1 plan M6 and snapshot-format.md section 2), so the walker, not the library, decides the container codes.
// It reads the frame header, every block header and the 4-byte checksum, and passes the frame bytes through; the
// decompressor still checks the block contents and the checksum value. snapshot-format.md sections 2 and 8.
import { SnapError } from "../errors.js";

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
/** Skippable frames: magic 0x184D2A50 to 0x184D2A5F, little endian `5? 2a 4d 18` (RFC 8878 section 3.1.2). */
const SKIPPABLE_TAIL = [0x2a, 0x4d, 0x18] as const;
/** Largest window a `.wgsnap` may need (`ZSTD_d_windowLogMax` 27). */
const MAX_WINDOW = 2 ** 27;
/** Block_Maximum_Size never exceeds 128 KiB (RFC 8878 section 3.1.1.2). */
const MAX_BLOCK = 2 ** 17;
const FCS_SIZES = [0, 2, 4, 8] as const;

type State =
  | { at: "magic"; read: number; skippable: boolean }
  | { at: "descriptor" }
  | { at: "header"; need: number; got: number[]; singleSegment: boolean; fcsBytes: number }
  | { at: "blockHeader"; got: number[] }
  | { at: "blockBody"; left: number; last: boolean }
  | { at: "checksum"; left: number }
  | { at: "done" };

const invalid = (message: string): never => {
  throw new SnapError("SNAP_ZSTD_INVALID", message);
};

/**
 * Feed the compressed input with `push` (which returns the bytes that belong to the frame) and call `end` when the
 * input ends. Errors: `SNAP_ZSTD_INVALID` (not a zstd frame, a skippable frame, the reserved descriptor bit, a
 * dictionary id, a window above 2^27, the reserved block type, a block above 128 KiB), `SNAP_ZSTD_NO_CHECKSUM`,
 * `SNAP_TRAILING_DATA` (any byte after the frame) and, from `end`, `SNAP_TRUNCATED`. The first bad byte decides, so
 * the verdict does not depend on how the input is chunked; after a failure every call throws the same error.
 */
export class ZstdFrameWalker {
  #state: State = { at: "magic", read: 0, skippable: false };
  #failure: SnapError | undefined;
  #accepted = 0;

  /** True once the last block and the checksum have been read. */
  get done(): boolean {
    return this.#state.at === "done";
  }

  /** After `push` threw: the number of bytes of that chunk that came before the bad byte. */
  get accepted(): number {
    return this.#accepted;
  }

  push(chunk: Uint8Array): Uint8Array {
    if (this.#failure !== undefined) {
      this.#accepted = 0;
      throw this.#failure;
    }
    let i = 0;
    try {
      while (i < chunk.length) {
        const state = this.#state;
        if (state.at === "done") {
          throw new SnapError("SNAP_TRAILING_DATA", "bytes after the zstd frame");
        }
        if (state.at === "blockBody" || state.at === "checksum") {
          const take = Math.min(state.left, chunk.length - i);
          state.left -= take;
          i += take;
          if (state.left === 0) {
            this.#state =
              state.at === "checksum"
                ? { at: "done" }
                : state.last
                  ? { at: "checksum", left: 4 }
                  : { at: "blockHeader", got: [] };
          }
          continue;
        }
        this.#byte(chunk[i] as number);
        i++;
      }
    } catch (error) {
      this.#accepted = i;
      this.#failure = error as SnapError;
      throw error;
    }
    this.#accepted = chunk.length;
    return chunk;
  }

  /** The input has ended: anything short of a complete frame is `SNAP_TRUNCATED`. */
  end(): void {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#state.at !== "done") {
      throw new SnapError("SNAP_TRUNCATED", "the zstd frame ends early");
    }
  }

  #byte(byte: number): void {
    const state = this.#state;
    switch (state.at) {
      case "magic":
        this.#magic(state, byte);
        return;
      case "descriptor":
        this.#descriptor(byte);
        return;
      case "header":
        state.got.push(byte);
        if (state.got.length === state.need) {
          this.#header(state);
        }
        return;
      case "blockHeader":
        state.got.push(byte);
        if (state.got.length === 3) {
          this.#blockHeader(state.got as [number, number, number]);
        }
        return;
      default:
        return;
    }
  }

  #magic(state: Extract<State, { at: "magic" }>, byte: number): void {
    if (state.read === 0 && byte >= 0x50 && byte <= 0x5f) {
      state.skippable = true;
    } else if (
      state.skippable ? byte !== SKIPPABLE_TAIL[state.read - 1] : byte !== MAGIC[state.read]
    ) {
      invalid("not a zstd frame");
    }
    state.read++;
    if (state.read === 4) {
      if (state.skippable) {
        invalid("a skippable frame where the zstd frame must start");
      }
      this.#state = { at: "descriptor" };
    }
  }

  #descriptor(fhd: number): void {
    // Bits 7-6 content size flag, 5 single segment, 4 unused, 3 reserved, 2 checksum, 1-0 dictionary id flag.
    if (fhd & 0x08) {
      invalid("the reserved frame header bit is set");
    }
    if (fhd & 0x03) {
      invalid("the frame needs a dictionary");
    }
    if (!(fhd & 0x04)) {
      throw new SnapError("SNAP_ZSTD_NO_CHECKSUM", "the zstd frame has no content checksum");
    }
    const singleSegment = (fhd & 0x20) !== 0;
    const fcsFlag = fhd >> 6;
    const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : (FCS_SIZES[fcsFlag] as number);
    const need = (singleSegment ? 0 : 1) + fcsBytes;
    const header: State = { at: "header", need, got: [], singleSegment, fcsBytes };
    if (need === 0) {
      this.#header(header);
    } else {
      this.#state = header;
    }
  }

  #header(state: Extract<State, { at: "header" }>): void {
    const fields = state.got;
    let window: number;
    if (state.singleSegment) {
      // The window is the content size; a 2-byte field stores the size minus 256.
      let size = 0;
      for (let i = state.fcsBytes - 1; i >= 0; i--) {
        size = size * 256 + (fields[i] as number);
      }
      window = state.fcsBytes === 2 ? size + 256 : size;
    } else {
      const descriptor = fields[0] as number;
      const base = 2 ** (10 + (descriptor >> 3));
      window = base + (base / 8) * (descriptor & 0x07);
    }
    if (window > MAX_WINDOW) {
      invalid("the zstd frame needs a window above 2^27");
    }
    this.#state = { at: "blockHeader", got: [] };
  }

  #blockHeader([b0, b1, b2]: [number, number, number]): void {
    const header = b0 | (b1 << 8) | (b2 << 16);
    const last = (header & 1) === 1;
    const type = (header >> 1) & 0x03;
    const size = header >>> 3;
    if (type === 3) {
      invalid("reserved zstd block type");
    }
    if (size > MAX_BLOCK) {
      invalid("zstd block above 128 KiB");
    }
    // Raw blocks carry `size` bytes, RLE blocks one byte repeated `size` times, compressed blocks `size` bytes.
    const left = type === 1 ? 1 : size;
    if (left > 0) {
      this.#state = { at: "blockBody", left, last };
    } else {
      this.#state = last ? { at: "checksum", left: 4 } : { at: "blockHeader", got: [] };
    }
  }
}
