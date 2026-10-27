import type { WritableDb } from "../database.js";

/**
 * The `settings` table: key to JSON value. Which keys exist and what their values may be is decided by the settings
 * IPC handler (allowlist and zod schema); this repository only stores what it is given.
 */
export function createSettingsRepo(db: WritableDb) {
  const get = db.raw.prepare("SELECT value FROM settings WHERE key = ?");
  const set = db.raw.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const all = db.raw.prepare("SELECT key, value FROM settings ORDER BY key");
  return {
    /** The stored value, or undefined if the key was never set. */
    get(key: string): unknown {
      const row = get.get(key) as { value: string } | undefined;
      return row === undefined ? undefined : JSON.parse(row.value);
    },
    set(key: string, value: unknown): void {
      const json = JSON.stringify(value);
      if (json === undefined) throw new TypeError(`settings.set: "${key}" has no JSON form.`);
      set.run(key, json);
    },
    all(): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const row of all.all() as unknown as Array<{ key: string; value: string }>) {
        out[row.key] = JSON.parse(row.value);
      }
      return out;
    },
  };
}
