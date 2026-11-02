import { readFileSync } from "node:fs";
import { type CborItem, decodeSchema, decodeStoreRecords } from "@wg-launcher/snapshot";
import { adapterScope, parseAdapter } from "../src/adapters/schema.js";
import type { FrameResult, FrameSummary } from "../src/index.js";
import {
  contentHashOf,
  entryBytes,
  expect,
  inFreshContext,
  play,
  progressHash,
  test,
  topKey,
  type WireEntry,
} from "./harness.js";

const ALL = { localStorage: "all", indexedDB: "all" };

interface Exported {
  result: FrameResult<FrameSummary>;
  entries: WireEntry[];
}

const PROGRESS_LAB = parseAdapter(
  JSON.parse(readFileSync(new URL("../src/adapters/progress-lab.json", import.meta.url), "utf8")),
);

/** The tag of each member of a plain-object value item (tag 33101), by member name. */
function memberTags(item: CborItem): Record<string, number | string> {
  if (item.k !== "tag" || item.tag !== 33101 || item.v.k !== "array")
    throw new Error("not an object");
  const out: Record<string, number | string> = {};
  for (let i = 0; i < item.v.v.length; i += 2) {
    const key = item.v.v[i] as CborItem;
    const value = item.v.v[i + 1] as CborItem;
    out[(key as { v: string }).v] = value.k === "tag" ? value.tag : value.k;
  }
  return out;
}

test("AC-7: progress-lab exported after 7 steps restores into a fresh context with its own hash equal", async ({
  page,
  lab,
  openStub,
}) => {
  const played = await play(page, lab, 7);
  const world = await openStub(page);
  const request = { keyIndex: 0, storageKey: topKey(lab), scope: ALL };
  const exported = await world.call<Exported>("exportFrame", request);

  expect(exported.result).toEqual({
    ok: true,
    data: {
      localStorageItems: 2,
      databases: [
        { name: "/home/web_user", version: 21, stores: 1, records: 3 },
        { name: "progress-lab", version: 1, stores: 2, records: 8 },
      ],
      blobs: 1,
      notExported: [],
    },
  });
  const paths = exported.entries.map((e) => e.path).sort();
  expect(paths).toEqual([
    expect.stringMatching(/^blobs\/[0-9a-f]{64}$/),
    "data/0/idb/0/schema.cbor",
    "data/0/idb/0/store-0.cbor",
    "data/0/idb/1/schema.cbor",
    "data/0/idb/1/store-0.cbor",
    "data/0/idb/1/store-1.cbor",
    "data/0/local-storage.cbor",
  ]);

  // Values read through the isolated world keep their classes (exact-prototype checks): Date (33104),
  // ArrayBuffer (bytes), Uint8Array (tag 64) and Blob (33111).
  const refs = new Map<string, number>();
  const [profile] = decodeStoreRecords(
    entryBytes(exported.entries, "data/0/idb/1/store-0.cbor"),
    refs,
  );
  expect(memberTags(profile?.value as CborItem)).toMatchObject({
    updatedAt: 33104,
    checksum: "bytes",
    thumbnail: 33111,
  });
  const steps = decodeStoreRecords(entryBytes(exported.entries, "data/0/idb/1/store-1.cbor"), refs);
  expect(steps.map((r) => r.key)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(memberTags(steps[0]?.value as CborItem)).toMatchObject({ at: 33104, roll: 64 });
  const files = decodeStoreRecords(entryBytes(exported.entries, "data/0/idb/0/store-0.cbor"), refs);
  expect(memberTags(files[2]?.value as CborItem)).toMatchObject({ timestamp: 33104, contents: 64 });
  const schema = decodeSchema(entryBytes(exported.entries, "data/0/idb/1/schema.cbor"));
  expect(schema.stores.map((s) => [s.name, s.keyGenerator, s.records])).toEqual([
    ["profile", null, 1],
    ["stepLog", 8, 7],
  ]);

  await inFreshContext(page, async (target) => {
    const targetWorld = await openStub(target);
    expect(await targetWorld.call("importFrame", exported.entries, request)).toEqual({
      ok: true,
      data: exported.result.ok ? exported.result.data : null,
    });
    // Re-exporting the restored frame gives the same entries: nothing was lost or changed.
    const again = await targetWorld.call<Exported>("exportFrame", request);
    expect(contentHashOf(again.entries, lab)).toBe(contentHashOf(exported.entries, lab));
    expect(await progressHash(target, lab)).toBe(played);
  });
});

test("every value kind round-trips through the isolated world, keeping its class in the page", async ({
  page,
  lab,
  openStub,
}) => {
  await openStub(page);
  // Written by the page's main world; read by the exporter in its isolated world.
  await page.evaluate(async () => {
    localStorage.setItem("lone \ud800", "value \udc00");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("kinds", 3);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("values");
        const keyed = open.result.createObjectStore("keyed", { keyPath: ["a", "b"] });
        keyed.createIndex("by-tags", "tags", { unique: false, multiEntry: true });
        keyed.createIndex("by-b", "b", { unique: true });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const buffer = new ArrayBuffer(8);
    new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const sparse: unknown[] = [];
    sparse[3] = "three";
    (sparse as unknown as Record<string, unknown>).extra = true;
    const values: [IDBValidKey, unknown][] = [
      [1, new Date(Date.UTC(2026, 0, 2))],
      [
        2,
        new Map<unknown, unknown>([
          ["k", 1],
          [2, [new Date(0)]],
        ]),
      ],
      [3, new Set(["a", 1, null])],
      [4, new Uint8Array([9, 8, 7])],
      [5, new Float16Array([1.5, -2.25])],
      [6, new DataView(new Uint8Array([4, 5]).buffer)],
      [7, new Uint16Array(buffer, 2, 2)],
      [8, new Uint8Array([0xde, 0xad]).buffer],
      [9, new Blob(["blob bytes"], { type: "text/plain" })],
      [
        10,
        new File(["file bytes"], "save.dat", {
          type: "application/x-save",
          lastModified: 1_700_000_000_000,
        }),
      ],
      [11, /a+b/giu],
      [12, [Object(true), Object(2), Object("s"), Object(5n)]],
      [13, 2n ** 70n],
      [14, sparse],
      [15, "lone \udbff"],
      [16, { nested: { deeper: [-0, Number.NaN, Number.POSITIVE_INFINITY, undefined, null] } }],
      [17, new BigInt64Array([-1n, 2n ** 62n])],
      ["string key", "s"],
      [new Date(5), "date key"],
      [new Uint8Array([1, 2]).buffer, "binary key"],
      [[1, "two", [3]], "array key"],
    ];
    const tx = db.transaction(["values", "keyed"], "readwrite");
    for (const [key, value] of values) tx.objectStore("values").put(value, key);
    tx.objectStore("keyed").put({ a: 1, b: "x", tags: ["t1", "t2"] });
    tx.objectStore("keyed").put({ a: 1, b: "y", tags: [] });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  const world = await openStub(page);
  const request = { keyIndex: 0, storageKey: topKey(lab), scope: ALL };
  const exported = await world.call<Exported>("exportFrame", request);
  expect(exported.result).toMatchObject({ ok: true, data: { blobs: 2 } });

  await inFreshContext(page, async (target) => {
    const targetWorld = await openStub(target);
    expect(await targetWorld.call("importFrame", exported.entries, request)).toMatchObject({
      ok: true,
    });
    const again = await targetWorld.call<Exported>("exportFrame", request);
    expect(again.entries.map((e) => [e.path, e.base64]).sort()).toEqual(
      exported.entries.map((e) => [e.path, e.base64]).sort(),
    );
    // Read back by the page's main world: the classes are the page's own.
    const seen = await target.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("kinds");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const store = db.transaction("values").objectStore("values");
      const get = (key: IDBValidKey) =>
        new Promise<unknown>((resolve) => {
          const request = store.get(key);
          request.onsuccess = () => resolve(request.result);
        });
      const [date, map, set, f16, view, partial, blob, file, regexp] = await Promise.all(
        [1, 2, 3, 5, 6, 7, 9, 10, 11].map(get),
      );
      const out = {
        date: date instanceof Date && date.toISOString(),
        map: map instanceof Map && (map.get(2) as Date[])[0] instanceof Date,
        set: set instanceof Set && [...set],
        f16: f16 instanceof Float16Array && [...f16],
        view: view instanceof DataView && view.getUint8(1),
        partial: partial instanceof Uint16Array && [partial.byteOffset, partial.length],
        blob: blob instanceof Blob && !(blob instanceof File) && [blob.type, await blob.text()],
        file: file instanceof File && [file.name, file.lastModified, file.type, await file.text()],
        regexp: regexp instanceof RegExp && regexp.flags,
        localStorage: localStorage.getItem("lone \ud800") === "value \udc00",
        indexes: [...db.transaction("keyed").objectStore("keyed").indexNames],
        version: db.version,
      };
      db.close();
      return out;
    });
    expect(seen).toEqual({
      date: "2026-01-02T00:00:00.000Z",
      map: true,
      set: ["a", 1, null],
      f16: [1.5, -2.25],
      view: 5,
      partial: [2, 2],
      blob: ["text/plain", "blob bytes"],
      file: ["save.dat", 1_700_000_000_000, "application/x-save", "file bytes"],
      regexp: "giu",
      localStorage: true,
      indexes: ["by-b", "by-tags"],
      version: 3,
    });
  });
});

test("an adapter scope exports only the selected localStorage prefixes and databases", async ({
  page,
  lab,
  openStub,
}) => {
  await play(page, lab, 1);
  await page.evaluate(async () => {
    localStorage.setItem("other", "not the game's");
    await new Promise((resolve) => {
      const open = indexedDB.open("other-db", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("s");
      open.onsuccess = () => resolve(open.result.close());
    });
  });
  const world = await openStub(page);
  const exported = await world.call<Exported>("exportFrame", {
    keyIndex: 0,
    storageKey: topKey(lab),
    scope: adapterScope(PROGRESS_LAB),
  });
  expect(exported.result).toMatchObject({
    ok: true,
    data: {
      localStorageItems: 2,
      databases: [{ name: "/home/web_user" }, { name: "progress-lab" }],
    },
  });
  expect(exported.entries.filter((e) => e.path.startsWith("data/0/idb/2"))).toEqual([]);
});
