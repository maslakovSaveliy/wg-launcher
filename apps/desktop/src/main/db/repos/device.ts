import { uuidv7 } from "@wg-launcher/shared";
import type { WritableDb } from "../database.js";

export interface Device {
  id: string;
  createdAt: number;
}

interface DeviceRow {
  id: string;
  created_at: number;
}

/** The `device` table: one row, a random UUIDv7 made on the first open (it names this machine in snapshots). */
export function createDeviceRepo(db: WritableDb) {
  const select = db.raw.prepare("SELECT id, created_at FROM device LIMIT 1");
  const insert = db.raw.prepare("INSERT INTO device (id, created_at) VALUES (?, ?)");
  const get = (): Device | null => {
    const row = select.get() as DeviceRow | undefined;
    return row ? { id: row.id, createdAt: row.created_at } : null;
  };
  return {
    get,
    /** Creates the row if the table is empty; returns the (new or existing) device. */
    ensure(): Device {
      return db.transaction(() => {
        const existing = get();
        if (existing) return existing;
        const createdAt = db.now();
        const id = uuidv7(db.now);
        insert.run(id, createdAt);
        return { id, createdAt };
      });
    },
  };
}
