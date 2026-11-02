// Origins and sites as the manifest writes them (snapshot-format.md section 4): the WHATWG serialization of an http or
// https origin, which parses and serializes back to itself; a site is the same without a port.

export function isHttpOrigin(value: string, allowPort = true): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value &&
    (allowPort || url.port === "")
  );
}
