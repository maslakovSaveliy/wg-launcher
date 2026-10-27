import { describe, expect, it } from "vitest";
import { canonicalJson } from "./jcs.js";

describe("canonicalJson (RFC 8785 for the manifest subset)", () => {
  it("sorts object keys by UTF-16 code units, recursively, with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: false }] })).toBe(
      '{"a":[true,null,{"c":false,"d":"x"}],"b":1}',
    );
    // U+FB01 sorts after U+1F600's high surrogate (0xD83D) in code-unit order, but before it in code-point order.
    expect(canonicalJson({ "\u{1F600}": 1, ﬁ: 2 })).toBe('{"\u{1F600}":1,"ﬁ":2}');
  });

  it("escapes strings as RFC 8785 section 3.2.2.2 says, for every ASCII character", () => {
    const short: Record<number, string> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
    for (let c = 0; c < 0x80; c++) {
      const s = String.fromCharCode(c);
      const expected =
        c === 0x22
          ? '\\"'
          : c === 0x5c
            ? "\\\\"
            : c < 0x20
              ? (short[c] ?? `\\u${c.toString(16).padStart(4, "0")}`)
              : s;
      expect(canonicalJson(s)).toBe(`"${expected}"`);
    }
    expect(canonicalJson("é \u{1F600}")).toBe('"é \u{1F600}"');
  });

  it("writes safe integers in plain decimal and refuses every other number", () => {
    expect(canonicalJson([0, -1, 2 ** 53 - 1])).toBe("[0,-1,9007199254740991]");
    for (const n of [1.5, -0, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => canonicalJson(n)).toThrow(RangeError);
    }
  });

  it("refuses strings with a lone surrogate and values JSON cannot hold", () => {
    expect(() => canonicalJson("\uD800")).toThrow(RangeError);
    expect(() => canonicalJson({ "\uDC00": 1 })).toThrow(RangeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(1n)).toThrow(TypeError);
  });

  it("detects whitespace and duplicate keys when the parsed text is re-serialized", () => {
    const same = (text: string) => canonicalJson(JSON.parse(text)) === text;
    expect(same('{"a":1,"b":[1,2]}')).toBe(true);
    expect(same('{"a": 1}')).toBe(false);
    expect(same('{"a":1}\n')).toBe(false);
    expect(same('{"a":1,"a":1}')).toBe(false);
    expect(same('{"b":1,"a":2}')).toBe(false);
    expect(same('{"a":"\\u0041"}')).toBe(false);
    expect(same('{"a":1.0}')).toBe(false);
  });
});
