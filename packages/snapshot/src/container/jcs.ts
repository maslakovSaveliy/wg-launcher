// RFC 8785 (JCS) for the values a `.wgsnap` manifest may hold: objects, arrays, strings, safe integers, booleans and
// `null` (snapshot-format.md sections 4 and 5). Keeping numbers to safe integers means no implementation needs the
// ECMAScript float formatting of RFC 8785 section 3.2.2.3.
//
// Strings: for a well-formed string, JSON.stringify produces exactly the escaping of RFC 8785 section 3.2.2.2
// (`"` and `\` escaped; U+0008, U+0009, U+000A, U+000C and U+000D as \b \t \n \f \r; other characters below U+0020
// as \u00xx in lowercase hex; everything else literal). `jcs.test.ts` checks this for every ASCII character. A lone
// surrogate is refused: RFC 8785 requires I-JSON, and JSON.stringify would escape it instead.

/** The JCS serialization. RangeError for a number that is not a safe integer or a lone surrogate; TypeError for a
 * value JSON cannot hold. */
export function canonicalJson(value: unknown): string {
  switch (typeof value) {
    case "string":
      return stringJson(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new RangeError("JCS subset: numbers must be safe integers");
      }
      return String(value);
    case "object":
      if (value === null) {
        return "null";
      }
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
      }
      return objectJson(value as Record<string, unknown>);
    default:
      throw new TypeError(`JCS subset: ${typeof value} is not a JSON value`);
  }
}

function stringJson(s: string): string {
  if (!s.isWellFormed()) {
    throw new RangeError("JCS: a string holds a lone surrogate");
  }
  return JSON.stringify(s);
}

function objectJson(object: Record<string, unknown>): string {
  // Array.prototype.sort without a comparator orders strings by UTF-16 code units, as RFC 8785 section 3.2.3 says.
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${stringJson(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
