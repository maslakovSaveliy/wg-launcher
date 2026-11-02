// Export and restore scopes (save-transfer.md sections 3 and 8). localStorage selectors are key prefixes, IndexedDB
// selectors whole database names; both are plain strings, never regular expressions or globs.

export type Selection = "all" | { include: readonly string[]; exclude: readonly string[] };

export interface FrameScope {
  localStorage: Selection;
  indexedDB: Selection;
}

export const ALL: FrameScope = { localStorage: "all", indexedDB: "all" };

export function selectsKey(selection: Selection, key: string): boolean {
  if (selection === "all") {
    return true;
  }
  return (
    selection.include.some((prefix) => key.startsWith(prefix)) &&
    !selection.exclude.some((prefix) => key.startsWith(prefix))
  );
}

export function selectsDatabase(selection: Selection, name: string): boolean {
  if (selection === "all") {
    return true;
  }
  return selection.include.includes(name) && !selection.exclude.includes(name);
}
