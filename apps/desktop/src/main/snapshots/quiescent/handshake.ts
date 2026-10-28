// The quiescent handshake (save-transfer.md section 5, step 9, QW-4): each preload instance sends one `ipcRenderer`
// message with the job nonce. Main accepts it only from the job's `webContents`, from a frame whose URL is one of the
// job's expected stub URLs, with exactly the job nonce (128 random bits from `crypto.randomBytes`, compared in
// constant time), and only once per frame; only then does that frame get its end of a message port.
import { randomBytes, timingSafeEqual } from "node:crypto";

/** The preload's hello (`ipcRenderer.send`), and main's answer that carries the port (`WebFrameMain.postMessage`). */
export const HELLO_CHANNEL = "wg:quiescent:hello";
export const PORT_CHANNEL = "wg:quiescent:port";

const NONCE = /^[0-9a-f]{32}$/;

export const isJobNonce = (value: unknown): value is string =>
  typeof value === "string" && NONCE.test(value);

export const newJobNonce = (): string => randomBytes(16).toString("hex");

export type HelloRefusal = "wrong-contents" | "wrong-frame" | "wrong-nonce" | "already-connected";

export interface HelloEvent {
  sender: unknown;
  senderFrame: { url: string } | null;
}

/** The hello's only shape: `{job}`, nothing else. */
function nonceOf(message: unknown): string | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const keys = Object.keys(message);
  const job = (message as { job?: unknown }).job;
  return keys.length === 1 && isJobNonce(job) ? job : null;
}

export function createHandshake<K>(options: {
  contents: unknown;
  jobNonce: string;
  /** Expected stub URL to whatever the frame resolves (its storage key). */
  frames: ReadonlyMap<string, K>;
}) {
  const expected = Buffer.from(options.jobNonce, "hex");
  const connected = new Set<string>();
  return {
    accept(
      event: HelloEvent,
      message: unknown,
    ): { ok: true; key: K } | { ok: false; reason: HelloRefusal } {
      if (event.sender !== options.contents) return { ok: false, reason: "wrong-contents" };
      const url = event.senderFrame?.url;
      const key = url === undefined ? undefined : options.frames.get(url);
      if (url === undefined || key === undefined) return { ok: false, reason: "wrong-frame" };
      const nonce = nonceOf(message);
      if (nonce === null || !timingSafeEqual(Buffer.from(nonce, "hex"), expected)) {
        return { ok: false, reason: "wrong-nonce" };
      }
      if (connected.has(url)) return { ok: false, reason: "already-connected" };
      connected.add(url);
      return { ok: true, key };
    },
    /** Expected frames that have not said hello yet. */
    pending: (): string[] => [...options.frames.keys()].filter((url) => !connected.has(url)),
  };
}
