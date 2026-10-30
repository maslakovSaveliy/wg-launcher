import { decodeSchema } from "@wg-launcher/snapshot";
import type { FrameResult, FrameSummary } from "../src/index.js";
import {
  contentHashOf,
  entryBytes,
  expect,
  inFreshContext,
  play,
  playMore,
  test,
  topKey,
  type WireEntry,
} from "./harness.js";

const ALL = { localStorage: "all", indexedDB: "all" };

interface Exported {
  result: FrameResult<FrameSummary>;
  entries: WireEntry[];
}

const generators = (entries: WireEntry[], path: string) =>
  decodeSchema(entryBytes(entries, path)).stores.map((s) => [s.name, s.keyGenerator]);

/** Runs in the page's main world: the primary keys of a store. */
function storeKeys([name, store]: [string, string]): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction(store).objectStore(store).getAllKeys();
      request.onsuccess = () => {
        open.result.close();
        resolve(request.result);
      };
    };
  });
}

/** Runs in the page's main world: adds one record to each store and returns the generated keys. */
function addOne(stores: [string, boolean][]): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("gen");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(
        stores.map(([s]) => s),
        "readwrite",
      );
      const keys: IDBValidKey[] = [];
      for (const [store, inline] of stores) {
        const request = tx.objectStore(store).add(inline ? { added: true } : "added");
        request.onsuccess = () => keys.push(request.result);
      }
      tx.oncomplete = () => {
        open.result.close();
        resolve(keys);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const request = (lab: { origin: string }) => ({
  keyIndex: 0,
  storageKey: topKey(lab),
  scope: ALL,
});

test("the key-generator probe is stable: two exports give the same keyGenerator and contentHash (open check 2)", async ({
  page,
  lab,
  openStub,
}) => {
  await play(page, lab, 7);
  const world = await openStub(page);
  const first = await world.call<Exported>("exportFrame", request(lab));
  const second = await world.call<Exported>("exportFrame", request(lab));
  expect(first.result.ok && second.result.ok).toBe(true);
  expect(generators(first.entries, "data/0/idb/1/schema.cbor")).toEqual([
    ["profile", null],
    ["stepLog", 8],
  ]);
  expect(generators(second.entries, "data/0/idb/1/schema.cbor")).toEqual(
    generators(first.entries, "data/0/idb/1/schema.cbor"),
  );
  expect(contentHashOf(second.entries, lab)).toBe(contentHashOf(first.entries, lab));

  // Chromium reverted the generator on each aborted probe: the game's next step still gets key 8.
  await page.goto(`${lab.origin}/`);
  await playMore(page, 1);
  expect(await page.evaluate(storeKeys, ["progress-lab", "stepLog"] as [string, string])).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
});

test("a generator above the highest key + 1 is exported by the probe and restored: the next add gets it", async ({
  page,
  lab,
  openStub,
}) => {
  await openStub(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open("gen", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("out-of-line", { autoIncrement: true });
        const inline = open.result.createObjectStore("inline", {
          keyPath: "id.n",
          autoIncrement: true,
        });
        inline.createIndex("unique-added", "added", { unique: true });
      };
      open.onsuccess = () => resolve(open.result);
    });
    const tx = db.transaction(["out-of-line", "inline"], "readwrite");
    const outOfLine = tx.objectStore("out-of-line");
    for (let i = 0; i < 5; i++) outOfLine.add(`record ${i}`);
    outOfLine.delete(IDBKeyRange.lowerBound(4)); // keys 1 to 3 stay, the generator is at 6
    const inline = tx.objectStore("inline");
    inline.add({ v: 1 });
    inline.put({ id: { n: 10.5 }, v: 2 }); // an explicit key moves the generator to 11
    inline.delete(10.5);
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
    });
    db.close();
  });
  const world = await openStub(page);
  const exported = await world.call<Exported>("exportFrame", request(lab));
  expect(exported.result.ok).toBe(true);
  expect(generators(exported.entries, "data/0/idb/0/schema.cbor")).toEqual([
    ["inline", 11],
    ["out-of-line", 6],
  ]);

  await inFreshContext(page, async (target) => {
    const targetWorld = await openStub(target);
    expect(await targetWorld.call("importFrame", exported.entries, request(lab))).toMatchObject({
      ok: true,
    });
    const again = await targetWorld.call<Exported>("exportFrame", request(lab));
    expect(contentHashOf(again.entries, lab)).toBe(contentHashOf(exported.entries, lab));
    // The importer's placeholder is gone and the generator equals the exported one.
    expect(await target.evaluate(storeKeys, ["gen", "out-of-line"] as [string, string])).toEqual([
      1, 2, 3,
    ]);
    expect(await target.evaluate(storeKeys, ["gen", "inline"] as [string, string])).toEqual([1]);
    expect(
      await target.evaluate(addOne, [
        ["out-of-line", false],
        ["inline", true],
      ] as [string, boolean][]),
    ).toEqual([6, 11]);
  });
});

test("an exhausted key generator fails the export with EXP_KEY_GENERATOR_EXHAUSTED", async ({
  page,
  lab,
  openStub,
}) => {
  await openStub(page);
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const open = indexedDB.open("full", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("s", { autoIncrement: true });
      open.onsuccess = () => {
        const tx = open.result.transaction("s", "readwrite");
        tx.objectStore("s").put("last", 2 ** 53);
        tx.oncomplete = () => resolve(open.result.close());
      };
    });
  });
  const world = await openStub(page);
  const exported = await world.call<Exported>("exportFrame", request(lab));
  expect(exported.result).toMatchObject({
    ok: false,
    error: {
      code: "EXP_KEY_GENERATOR_EXHAUSTED",
      detail: { storageKey: topKey(lab), database: "full", store: "s" },
    },
  });
});
