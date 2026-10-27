// Small helpers shared by the repositories. No ORM: every repository holds its own SQL as plain constants.

import type { SQLInputValue } from "node:sqlite";
import type { WritableDb } from "../database.js";

/** SQLite has no boolean: 0 and 1. */
export const fromBool = (value: boolean): number => (value ? 1 : 0);
export const toBool = (value: number): boolean => value !== 0;

/**
 * `UPDATE table SET col = ?, ... WHERE key = ?` for the fields present in `patch`. `columns` maps the patch's
 * property names to column names and is the only source of identifiers in the statement, so a patch can never
 * name a column. A patch with no known field changes nothing and returns false.
 */
export function updateWhere(
  db: WritableDb,
  table: string,
  keyColumn: string,
  keyValue: SQLInputValue,
  patch: Readonly<Record<string, unknown>>,
  columns: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, SQLInputValue>> = {},
): boolean {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [property, column] of Object.entries(columns)) {
    const value = patch[property];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? fromBool(value) : (value as SQLInputValue));
  }
  if (sets.length === 0) return false;
  for (const [column, value] of Object.entries(extra)) {
    sets.push(`${column} = ?`);
    values.push(value);
  }
  const result = db.raw
    .prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${keyColumn} = ?`)
    .run(...values, keyValue);
  return result.changes > 0;
}
