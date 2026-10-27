import { describe, expect, it } from "vitest";
import { isUuidV7, uuidv7 } from "./ids.js";

const filled = (value: number) => (n: number) => new Uint8Array(n).fill(value);

describe("uuidv7", () => {
  it("puts the 48-bit millisecond time first, then version 7 and variant 10", () => {
    const id = uuidv7(
      () => 0x0123_4567_89ab,
      () => Uint8Array.from([0x0a, 0xbc, 0x3d, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab]),
    );

    expect(id).toBe("01234567-89ab-7abc-bdef-0123456789ab");
  });

  it("keeps the version nibble 7 and the variant in 8..b for all-zero and all-one random bytes", () => {
    const low = uuidv7(() => 1, filled(0x00));
    const high = uuidv7(() => 1, filled(0xff));

    expect(low[14]).toBe("7");
    expect(high[14]).toBe("7");
    expect(low[19]).toBe("8");
    expect(high[19]).toBe("b");
    expect(isUuidV7(low)).toBe(true);
    expect(isUuidV7(high)).toBe(true);
  });

  it("orders ids by time when the clock moves forward", () => {
    const ids = [1, 1_000, 1_700_000_000_000, 2 ** 48 - 1].map((time) =>
      uuidv7(
        () => time,
        () => crypto.getRandomValues(new Uint8Array(10)),
      ),
    );

    expect([...ids].sort()).toEqual(ids);
  });

  it("uses the real clock and Web Crypto by default, and does not repeat", () => {
    const before = Date.now();
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    const after = Date.now();

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(isUuidV7)).toBe(true);
    const time = Number.parseInt((ids[0] ?? "").replace("-", "").slice(0, 12), 16);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
  });

  it.each([-1, 2 ** 48, 1.5, Number.NaN])("rejects the timestamp %s", (time) => {
    expect(() => uuidv7(() => time)).toThrow(RangeError);
  });

  it("rejects a random source that returns the wrong number of bytes", () => {
    expect(() =>
      uuidv7(
        () => 1,
        () => new Uint8Array(9),
      ),
    ).toThrow(RangeError);
  });
});

describe("isUuidV7", () => {
  it("accepts a lowercase UUIDv7", () => {
    expect(isUuidV7("01234567-89ab-7abc-bdef-0123456789ab")).toBe(true);
    expect(isUuidV7("018f3c1e-0000-7000-8000-000000000000")).toBe(true);
  });

  it("rejects upper case", () => {
    expect(isUuidV7("01234567-89AB-7ABC-BDEF-0123456789AB")).toBe(false);
  });

  it("rejects other versions, such as a v4", () => {
    expect(isUuidV7("3f2b8c1e-5d4a-4e6f-9a1b-0c2d3e4f5a6b")).toBe(false);
  });

  it("rejects a wrong variant", () => {
    expect(isUuidV7("01234567-89ab-7abc-cdef-0123456789ab")).toBe(false);
  });

  it.each([
    "",
    "01234567-89ab-7abc-bdef-0123456789a",
    "01234567-89ab-7abc-bdef-0123456789abc",
    "0123456789ab7abcbdef0123456789ab",
    " 01234567-89ab-7abc-bdef-0123456789ab",
    "01234567-89ab-7abc-bdef-0123456789ab\n",
    "01234567-89ab-7abc-bdef-0123456789ag",
  ])("rejects the malformed value %j", (value) => {
    expect(isUuidV7(value)).toBe(false);
  });
});
