// The permission table of security.md section 5 (AC-4, AGENTS.md security invariant 3). Pure: Task 8 calls it from
// both the request and the check handler of every game session and logs each denial.

/** Exactly these three names are allowed; every other name, including future ones, is denied. */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "fullscreen",
  "pointerLock",
  "keyboardLock",
]);

/** A `Set` lookup, so inherited names such as `constructor` or `__proto__` never match. */
export function decidePermission(name: string): "allow" | "deny" {
  return typeof name === "string" && ALLOWED_PERMISSIONS.has(name) ? "allow" : "deny";
}
