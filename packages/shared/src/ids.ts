// UUIDv7 (RFC 9562): 48-bit Unix time in milliseconds, version 7, variant 10, 74 random bits.
// A game id must not depend on the URL (AGENTS.md, security invariant 2); this one is time-ordered and random.
// Only Web Crypto is used, so the module also works in the renderer and in sandboxed preloads (no Node imports).

const RANDOM_BYTES = 10;
const MAX_TIME = 2 ** 48 - 1;

/** The lowercase UUIDv7 pattern of architecture.md section 8 (deep links and the IPC id check). */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const defaultRandom = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * @param now milliseconds since the Unix epoch; defaults to `Date.now`
 * @param random returns `n` random bytes; defaults to Web Crypto
 */
export function uuidv7(
  now: () => number = Date.now,
  random: (n: number) => Uint8Array = defaultRandom,
): string {
  const time = now();
  if (!Number.isSafeInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`uuidv7: time ${time} is not a 48-bit millisecond count`);
  }
  const bytes = random(RANDOM_BYTES);
  if (bytes.length !== RANDOM_BYTES) {
    throw new RangeError(`uuidv7: expected ${RANDOM_BYTES} random bytes, got ${bytes.length}`);
  }

  const out = new Uint8Array(16);
  // Time as 48 bits, big endian; `/` and `%` because `>>` would truncate to 32 bits.
  for (let i = 5, rest = time; i >= 0; i--, rest = Math.floor(rest / 256)) {
    out[i] = rest % 256;
  }
  out.set(bytes, 6);
  out[6] = 0x70 | ((out[6] ?? 0) & 0x0f);
  out[8] = 0x80 | ((out[8] ?? 0) & 0x3f);

  const hex = Array.from(out, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True for a lowercase UUIDv7 in canonical form. Upper case, other versions and other variants are refused. */
export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}
