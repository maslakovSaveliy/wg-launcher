// THROWAWAY spike (runtime-compat). H10: node:sqlite and zstd steps, shared by the main process and
// the utilityProcess. node:sqlite is imported dynamically AFTER the warning listener is installed, so
// an ExperimentalWarning emitted on load is captured with its text.
import { randomBytes, createHash } from "node:crypto";
import { rmSync } from "node:fs";

export async function runSqliteAndZstd(dbPath) {
  const warnings = [];
  const onWarning = (warning) => warnings.push({ name: warning.name, message: warning.message });
  process.on("warning", onWarning);
  const steps = {};
  const step = async (name, fn) => {
    try {
      steps[name] = { ok: true, value: (await fn()) ?? null };
    } catch (error) {
      steps[name] = { ok: false, error: `${error.name}: ${error.message}` };
    }
    return steps[name].ok;
  };
  try {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    let sqlite;
    await step("import", async () => {
      sqlite = await import("node:sqlite");
      return Object.keys(sqlite).sort();
    });
    if (sqlite) {
      let db;
      await step("open", () => {
        db = new sqlite.DatabaseSync(dbPath);
      });
      await step("wal", () => {
        const row = db.prepare("PRAGMA journal_mode = WAL").get();
        if (row.journal_mode !== "wal") throw new Error(`journal_mode is ${row.journal_mode}`);
        return row.journal_mode;
      });
      await step("createTable", () => db.exec("CREATE TABLE games (id INTEGER PRIMARY KEY, title TEXT NOT NULL, blob BLOB)"));
      await step("insert", () => {
        const insert = db.prepare("INSERT INTO games (title, blob) VALUES (?, ?)");
        for (let i = 0; i < 100; i++) insert.run(`game-${i}`, Buffer.from([i, 255 - i]));
        return 100;
      });
      await step("select", () => {
        const rows = db.prepare("SELECT id, title, blob FROM games ORDER BY id").all();
        if (rows.length !== 100 || rows[42].title !== "game-42" || rows[42].blob[1] !== 213) {
          throw new Error("unexpected rows");
        }
        return { count: rows.length, sample: rows[42].title };
      });
      await step("userVersionWrite", () => db.exec("PRAGMA user_version = 7"));
      await step("userVersionRead", () => {
        const v = db.prepare("PRAGMA user_version").get().user_version;
        if (v !== 7) throw new Error(`user_version ${v}`);
        return v;
      });
      await step("close", () => db.close());
      await step("reopen", () => {
        const again = new sqlite.DatabaseSync(dbPath);
        try {
          const count = again.prepare("SELECT count(*) AS n FROM games").get().n;
          const version = again.prepare("PRAGMA user_version").get().user_version;
          const mode = again.prepare("PRAGMA journal_mode").get().journal_mode;
          if (count !== 100 || version !== 7 || mode !== "wal") throw new Error(`count ${count} version ${version} mode ${mode}`);
          return { count, version, mode };
        } finally {
          again.close();
        }
      });
    }
    await step("zstd", async () => {
      const zlib = await import("node:zlib");
      if (typeof zlib.zstdCompressSync !== "function") throw new Error("zlib.zstdCompressSync missing");
      const input = Buffer.concat([randomBytes(512 * 1024), Buffer.alloc(512 * 1024, 7)]);
      const packed = zlib.zstdCompressSync(input);
      const unpacked = zlib.zstdDecompressSync(packed);
      const same = createHash("sha256").update(input).digest("hex") === createHash("sha256").update(unpacked).digest("hex");
      if (!same) throw new Error("zstd round trip mismatch");
      return { inputBytes: input.length, compressedBytes: packed.length };
    });
  } finally {
    // Let warnings emitted on process.nextTick land before reporting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off("warning", onWarning);
  }
  const ok = Object.values(steps).every((s) => s.ok);
  return { ok, steps, warnings, versions: { node: process.versions.node, sqlite: process.versions.sqlite ?? null } };
}
