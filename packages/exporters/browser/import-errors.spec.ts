import { readFileSync } from "node:fs";
import {
  type CborItem,
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

// A record the snapshot worker would have refused already (Ruling R7: it compiles every RegExp during R1); the importer
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
