import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type CborItem,
  type DbSchema,
  encodeItem,
  encodeLocalStorage,
  encodeSchema,
  encodeStoreRecord,
} from "@wg-launcher/snapshot";
import { adapterScope, parseAdapter } from "../src/adapters/schema.js";
import type { FrameResult, FrameSummary } from "../src/index.js";
import {
  expect,
  inFreshContext,
  type Lab,
  type Page,
  play,
  test,
  topKey,
  type WireEntry,
  type World,
} from "./harness.js";

const ALL = { localStorage: "all", indexedDB: "all" };

interface Exported {
  result: FrameResult<FrameSummary>;
  entries: WireEntry[];
}

const PROGRESS_LAB = adapterScope(
  parseAdapter(
    JSON.parse(readFileSync(new URL("../src/adapters/progress-lab.json", import.meta.url), "utf8")),
  ),
);
const wire = (path: string, bytes: Uint8Array): WireEntry => ({
  path,
  base64: Buffer.from(bytes).toString("base64"),
});

/** Runs in the page's main world: what the frame holds, names only. */
async function storageState() {
  return {
    localStorage: Object.keys(localStorage).sort(),
    databases: (await indexedDB.databases()).map((d) => d.name).sort(),
  };
}

async function exportedLab(page: Page, lab: Lab, openStub: (page: Page) => Promise<World>) {
  await play(page, lab, 2);
  const world = await openStub(page);
  return world.call<Exported>("exportFrame", {
    keyIndex: 0,
    storageKey: topKey(lab),
    scope: ALL,
  });
}

const plan = (lab: Lab, scope: unknown = ALL) => ({
  keyIndex: 0,
  storageKey: topKey(lab),
  scope,
});

test("IMP_TARGET_NOT_EMPTY: a full import into a frame with any data writes nothing", async ({
  page,
  lab,
  openStub,
}) => {
  const { entries } = await exportedLab(page, lab, openStub);
  await inFreshContext(page, async (target) => {
    const world = await openStub(target);
    await target.evaluate(() => localStorage.setItem("left-over", "x"));
    expect(await world.call("importFrame", entries, plan(lab))).toMatchObject({
      ok: false,
      error: { code: "IMP_TARGET_NOT_EMPTY" },
    });
    expect(await target.evaluate(storageState)).toEqual({
      localStorage: ["left-over"],
      databases: [],
    });

    await target.evaluate(async () => {
      localStorage.clear();
      await new Promise((resolve) => {
        const open = indexedDB.open("progress-lab", 1);
        open.onsuccess = () => resolve(open.result.close());
      });
    });
    expect(await world.call("importFrame", entries, plan(lab))).toMatchObject({
      ok: false,
      error: { code: "IMP_TARGET_NOT_EMPTY" },
    });
    expect(await target.evaluate(storageState)).toEqual({
      localStorage: [],
      databases: ["progress-lab"],
    });
  });
});

test("a selective import checks only the selected keys and databases for emptiness", async ({
  page,
  lab,
  openStub,
}) => {
  const { entries } = await exportedLab(page, lab, openStub);
  await inFreshContext(page, async (target) => {
    const world = await openStub(target);
    await target.evaluate(() => localStorage.setItem("other", "kept"));
    expect(await world.call("importFrame", entries, plan(lab, PROGRESS_LAB))).toMatchObject({
      ok: true,
    });
    expect(await target.evaluate(storageState)).toEqual({
      localStorage: ["other", "progress-lab:format", "progress-lab:state"],
      databases: ["/home/web_user", "progress-lab"],
    });
  });
});

test("a selective import refuses entries outside its selection", async ({
  page,
  lab,
  openStub,
}) => {
  const { entries } = await exportedLab(page, lab, openStub);
  await inFreshContext(page, async (target) => {
    const world = await openStub(target);
    const narrow = {
      localStorage: PROGRESS_LAB.localStorage,
      indexedDB: { include: ["progress-lab"], exclude: [] },
    };
    expect(await world.call("importFrame", entries, plan(lab, narrow))).toMatchObject({
      ok: false,
      error: { code: "IMP_RECORD_INVALID", detail: { database: "/home/web_user" } },
    });
    expect(await target.evaluate(storageState)).toEqual({ localStorage: [], databases: [] });
  });
});

test("IMP_QUOTA_EXCEEDED: a full localStorage fails the import before any database is written", async ({
  page,
  lab,
  openStub,
}) => {
  const { entries } = await exportedLab(page, lab, openStub);
  await inFreshContext(page, async (target) => {
    const world = await openStub(target);
    await world.call("useQuotaLocalStorage", 1);
    expect(await world.call("importFrame", entries, plan(lab))).toMatchObject({
      ok: false,
      error: { code: "IMP_QUOTA_EXCEEDED" },
    });
    expect((await target.evaluate(storageState)).databases).toEqual([]);
  });
});

// A record the snapshot worker would have refused already (it compiles every RegExp during restore step R1); the importer
// refuses it as well, before writing anything.
test("a RegExp that does not compile is IMP_RECORD_INVALID with its record path, and nothing is written", async ({
  page,
  lab,
  openStub,
}) => {
  const text = (v: string): CborItem => ({ k: "text", v });
  const regexp: CborItem = { k: "tag", tag: 21066, v: { k: "array", v: [text("("), text("")] } };
  const store = {
    name: "s",
    keyPath: null,
    autoIncrement: false,
    keyGenerator: null,
    indexes: [],
    records: 1,
  };
  const entries = [
    wire("data/0/local-storage.cbor", encodeLocalStorage([["k", "v"]]) as Uint8Array),
    wire("data/0/idb/0/schema.cbor", encodeSchema({ name: "r", version: 1, stores: [store] })),
    wire("data/0/idb/0/store-0.cbor", encodeStoreRecord("rec", regexp)),
  ];
  const world = await openStub(page);
  expect(await world.call("importFrame", entries, plan(lab))).toMatchObject({
    ok: false,
    error: {
      code: "IMP_RECORD_INVALID",
      detail: { entry: "data/0/idb/0/store-0.cbor", database: "r", store: "s", recordKey: "rec" },
    },
  });
  expect(await page.evaluate(storageState)).toEqual({ localStorage: [], databases: [] });
});

test("a key that differs from the key IndexedDB derives from the value is IMP_KEY_MISMATCH", async ({
  page,
  lab,
  openStub,
}) => {
  const value: CborItem = {
    k: "tag",
    tag: 33101,
    v: {
      k: "array",
      v: [
        { k: "text", v: "id" },
        { k: "uint", v: 2 },
      ],
    },
  };
  const store = {
    name: "s",
    keyPath: "id",
    autoIncrement: false,
    keyGenerator: null,
    indexes: [],
    records: 1,
  };
  const entries = [
    wire("data/0/idb/0/schema.cbor", encodeSchema({ name: "m", version: 1, stores: [store] })),
    wire("data/0/idb/0/store-0.cbor", encodeStoreRecord(1, value)),
  ];
  const world = await openStub(page);
  expect(await world.call("importFrame", entries, plan(lab))).toMatchObject({
    ok: false,
    error: { code: "IMP_KEY_MISMATCH", detail: { database: "m", store: "s", recordKey: 1 } },
  });
});

test("wipe-selected removes only the selected localStorage keys and databases", async ({
  page,
  lab,
  openStub,
}) => {
  await play(page, lab, 1);
  await page.evaluate(async () => {
    localStorage.setItem("other", "kept");
    await new Promise((resolve) => {
      const open = indexedDB.open("other-db", 1);
      open.onsuccess = () => resolve(open.result.close());
    });
  });
  const world = await openStub(page);
  expect(await world.call("wipeSelected", PROGRESS_LAB)).toEqual({
    ok: true,
    data: { localStorageItems: 2, databases: ["/home/web_user", "progress-lab"] },
  });
  expect(await page.evaluate(storageState)).toEqual({
    localStorage: ["other"],
    databases: ["other-db"],
  });
});

// --- Failed requests, schemas IndexedDB refuses, unreferenced blobs, quota, a blocked wipe -----------

const uint = (v: number): CborItem => ({ k: "uint", v });
const txt = (v: string): CborItem => ({ k: "text", v });
const object = (members: [string, CborItem][]): CborItem => ({
  k: "tag",
  tag: 33101,
  v: { k: "array", v: members.flatMap(([key, value]) => [txt(key), value]) },
});
const lsEntry = wire("data/0/local-storage.cbor", encodeLocalStorage([["k", "v"]]) as Uint8Array);

/** Runs in the page's main world: the primary keys of every store of a database, or null when it does not exist. */
async function storedKeys(name: string): Promise<Record<string, IDBValidKey[]> | null> {
  if (!(await indexedDB.databases()).some((d) => d.name === name)) return null;
  const db = await new Promise<IDBDatabase>((resolve) => {
    const open = indexedDB.open(name);
    open.onsuccess = () => resolve(open.result);
  });
  const out: Record<string, IDBValidKey[]> = {};
  for (const store of [...db.objectStoreNames]) {
    out[store] = await new Promise((resolve) => {
      const request = db.transaction(store).objectStore(store).getAllKeys();
      request.onsuccess = () => resolve(request.result);
    });
  }
  db.close();
  return out;
}

test("a put that fails asynchronously (a unique-index ConstraintError) fails the import, never reports success", async ({
  page,
  lab,
  openStub,
}) => {
  const store = {
    name: "s",
    keyPath: null,
    autoIncrement: false,
    keyGenerator: null,
    indexes: [{ name: "by-u", keyPath: "u", unique: true, multiEntry: false }],
    records: 3,
  };
  const records: [number, number][] = [
    [1, 1],
    [2, 1],
    [3, 2],
  ];
  const entries = [
    wire("data/0/idb/0/schema.cbor", encodeSchema({ name: "u", version: 1, stores: [store] })),
    wire(
      "data/0/idb/0/store-0.cbor",
      Buffer.concat(records.map(([key, u]) => encodeStoreRecord(key, object([["u", uint(u)]])))),
    ),
  ];
  const world = await openStub(page);
  expect(await world.call("importFrame", entries, plan(lab))).toMatchObject({
    ok: false,
    error: {
      code: "IMP_RECORD_INVALID",
      detail: { database: "u", store: "s", recordKey: 2, reason: "ConstraintError" },
    },
  });
  // The chunk's transaction aborted as a whole: no record of it was committed.
  expect(await page.evaluate(storedKeys, "u")).toEqual({ s: [] });
});

test("a failing request while the key generator is raised fails the import", async ({
  page,
  lab,
  openStub,
}) => {
  const store = {
    name: "s",
    keyPath: null,
    autoIncrement: true,
    keyGenerator: 6,
    indexes: [],
    records: 1,
  };
  const entries = [
    wire("data/0/idb/0/schema.cbor", encodeSchema({ name: "g", version: 1, stores: [store] })),
    wire("data/0/idb/0/store-0.cbor", encodeStoreRecord(1, txt("a"))),
  ];
  const world = await openStub(page);
  await world.call("breakStoreDelete");
  const imported = await world.call<FrameResult<FrameSummary>>("importFrame", entries, plan(lab));
  expect(imported).toMatchObject({
    ok: false,
    error: { code: "INTERNAL", detail: { database: "g", store: "s" } },
  });
  // The raise's transaction aborted: the placeholder at keyGenerator - 1 was not committed.
  expect(await page.evaluate(storedKeys, "g")).toEqual({ s: [1] });
});

/** A schema.cbor written by hand, so that it can hold what encodeSchema refuses. */
function rawSchema(schema: DbSchema): Uint8Array {
  const keyPath = (p: string | string[] | null): CborItem =>
    p === null
      ? { k: "simple", v: null }
      : typeof p === "string"
        ? txt(p)
        : { k: "array", v: p.map(txt) };
  const stores = schema.stores.map(
    (st): CborItem => ({
      k: "map",
      v: [
        ["name", txt(st.name)],
        ["keyPath", keyPath(st.keyPath)],
        ["autoIncrement", { k: "simple", v: st.autoIncrement }],
        [
          "keyGenerator",
          st.keyGenerator === null ? { k: "simple", v: null } : uint(st.keyGenerator),
        ],
        ["indexes", { k: "array", v: [] }],
        ["records", uint(st.records)],
      ],
    }),
  );
  return encodeItem({
    k: "map",
    v: [
      ["name", txt(schema.name)],
      ["version", uint(schema.version)],
      ["stores", { k: "array", v: stores }],
    ],
  });
}

test("a schema IndexedDB would refuse (autoIncrement with an array key path) is IMP_RECORD_INVALID, nothing written", async ({
  page,
  lab,
  openStub,
}) => {
  const store = {
    name: "s",
    keyPath: ["a", "b"],
    autoIncrement: true,
    keyGenerator: 1,
    indexes: [],
    records: 0,
  };
  const entries = [
    lsEntry,
    wire("data/0/idb/0/schema.cbor", rawSchema({ name: "x", version: 1, stores: [store] })),
    wire("data/0/idb/0/store-0.cbor", new Uint8Array()),
  ];
  const world = await openStub(page);
  expect(await world.call("importFrame", entries, plan(lab))).toMatchObject({
    ok: false,
    error: { code: "IMP_RECORD_INVALID", detail: { entry: "data/0/idb/0/schema.cbor" } },
  });
  expect(await page.evaluate(storageState)).toEqual({ localStorage: [], databases: [] });
});

test("a blob entry that no record references is refused before anything is written", async ({
  page,
  lab,
  openStub,
}) => {
  const { entries } = await exportedLab(page, lab, openStub);
  const stray = new TextEncoder().encode("not referenced");
  const sha = createHash("sha256").update(stray).digest("hex");
  await inFreshContext(page, async (target) => {
    const world = await openStub(target);
    expect(
      await world.call("importFrame", [...entries, wire(`blobs/${sha}`, stray)], plan(lab)),
    ).toMatchObject({
      ok: false,
      error: { code: "IMP_RECORD_INVALID", detail: { entry: `blobs/${sha}` } },
    });
    expect(await target.evaluate(storageState)).toEqual({ localStorage: [], databases: [] });
  });
});

test("IndexedDB's QuotaExceededError is IMP_QUOTA_EXCEEDED, never ignored", async ({
  page,
  lab,
  openStub,
}) => {
  const store = {
    name: "s",
    keyPath: null,
    autoIncrement: false,
    keyGenerator: null,
    indexes: [],
    records: 1,
  };
  const big: CborItem = {
    k: "bytes",
    v: new Uint8Array(8 * 1024 * 1024).map((_, i) => (i * 7919) % 251),
  };
  const entries = [
    wire("data/0/idb/0/schema.cbor", encodeSchema({ name: "big", version: 1, stores: [store] })),
    wire("data/0/idb/0/store-0.cbor", encodeStoreRecord(1, big)),
  ];
  const world = await openStub(page);
  await world.cdp.send("Storage.overrideQuotaForOrigin", {
    origin: lab.origin,
    quotaSize: 1024 * 1024,
  });
  expect(await world.call("importFrame", entries, plan(lab))).toMatchObject({
    ok: false,
    error: { code: "IMP_QUOTA_EXCEEDED", detail: { database: "big", store: "s" } },
  });
});

test("wipe-selected fails with IMP_WIPE_FAILED when another connection blocks a delete", async ({
  page,
  lab,
  openStub,
}) => {
  await play(page, lab, 1);
  const world = await openStub(page);
  // The page's main world keeps a connection open and ignores versionchange.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("progress-lab");
        open.onsuccess = () => {
          (globalThis as Record<string, unknown>).held = open.result;
          resolve(null);
        };
      }),
  );
  expect(await world.call("wipeSelected", PROGRESS_LAB)).toMatchObject({
    ok: false,
    error: { code: "IMP_WIPE_FAILED", detail: { database: "progress-lab" } },
  });
});

test("after a blocked wipe-selected, the rollback's CDP clear settles the queued delete before anything is written again", async ({
  page,
  lab,
  openStub,
}) => {
  await play(page, lab, 1);
  const world = await openStub(page);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("progress-lab");
        open.onsuccess = () => {
          const db = open.result;
          const g = globalThis as Record<string, unknown>;
          g.held = db;
          g.closedByBrowser = false;
          db.onclose = () => {
            g.closedByBrowser = true;
          };
          resolve(null);
        };
      }),
  );
  expect(await world.call("wipeSelected", PROGRESS_LAB)).toMatchObject({
    ok: false,
    error: { code: "IMP_WIPE_FAILED" },
  });
  // The rollback's wipe: the whole key through CDP, as R5 does.
  const { frameTree } = await world.cdp.send("Page.getFrameTree");
  const { storageKey } = await world.cdp.send("Storage.getStorageKey", {
    frameId: frameTree.frame.id,
  });
  await world.cdp.send("Storage.clearDataForStorageKey", {
    storageKey,
    storageTypes: "local_storage,indexeddb",
  });
  const closedByBrowser = await page.evaluate(
    () => (globalThis as Record<string, unknown>).closedByBrowser,
  );
  // The rollback's import: the database again, with a record.
  await world.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open("progress-lab", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("s");
    open.onsuccess = () => {
      const tx = open.result.transaction("s", "readwrite");
      tx.objectStore("s").put("restored", 1);
      tx.oncomplete = () => { open.result.close(); resolve(null); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  })`);
  // The blocker goes away now, if the clear had not closed it already.
  await page.evaluate(() => ((globalThis as Record<string, unknown>).held as IDBDatabase).close());
  await page.waitForTimeout(500);
  const survived = await world.evaluate<string | null>(`new Promise((resolve) => {
    const open = indexedDB.open("progress-lab");
    open.onupgradeneeded = () => { open.transaction.abort(); resolve(null); };
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("s")) { db.close(); resolve(null); return; }
      const get = db.transaction("s").objectStore("s").get(1);
      get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
    };
    open.onerror = () => resolve(null);
  })`);
  console.log(JSON.stringify({ closedByBrowser, survived }));
  expect({ closedByBrowser, survived }).toEqual({ closedByBrowser: true, survived: "restored" });
});
