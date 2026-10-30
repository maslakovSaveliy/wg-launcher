import type { FrameInventory, FrameResult, FrameSummary } from "../src/index.js";
import { expect, play, test, topKey, type WireEntry } from "./harness.js";

const ALL = { localStorage: "all", indexedDB: "all" };

interface Exported {
  result: FrameResult<FrameSummary>;
  entries: WireEntry[];
}

test("AC-10: a CryptoKey in IndexedDB fails the export with EXP_UNSUPPORTED_VALUE naming where it is", async ({
  page,
  lab,
  openStub,
}) => {
  await openStub(page);
  await page.evaluate(async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, [
      "encrypt",
    ]);
    await new Promise((resolve) => {
      const open = indexedDB.open("keys-db", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("s");
      open.onsuccess = () => {
        const tx = open.result.transaction("s", "readwrite");
        tx.objectStore("s").put({ fine: 1 }, "rec-0");
        tx.objectStore("s").put({ a: [0, key] }, "rec-1");
        tx.oncomplete = () => resolve(open.result.close());
      };
    });
  });
  const world = await openStub(page);
  const exported = await world.call<Exported>("exportFrame", {
    keyIndex: 0,
    storageKey: topKey(lab),
    scope: ALL,
  });
  expect(exported.result).toEqual({
    ok: false,
    error: {
      code: "EXP_UNSUPPORTED_VALUE",
      message: expect.stringContaining("[object CryptoKey]"),
      detail: {
        storageKey: topKey(lab),
        database: "keys-db",
        store: "s",
        recordKey: "rec-1",
        path: ["a", 1],
        type: "[object CryptoKey]",
      },
    },
  });
});

test("the exporter never touches cookies, cookieStore, Cache Storage, credentials or service workers (AC-20)", async ({
  page,
  lab,
  openStub,
}) => {
  await play(page, lab, 1);
  await page.evaluate(async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: the test plants a cookie the exporter must never read.
    document.cookie = "sid=secret; path=/";
    const cache = await caches.open("game-assets");
    await cache.put("/asset", new Response("cached bytes"));
  });
  const world = await openStub(page);
  await world.evaluate("globalThis.touched = wgExporters.spyOnCredentials()");
  // The spy itself works: a read in the isolated world is recorded.
  await world.evaluate("document.cookie");
  expect(await world.evaluate("globalThis.touched.splice(0)")).toEqual(["cookie"]);

  const inventory = await world.call<FrameResult<FrameInventory>>("inventory");
  const exported = await world.call<Exported>("exportFrame", {
    keyIndex: 0,
    storageKey: topKey(lab),
    scope: ALL,
  });
  expect(await world.evaluate("globalThis.touched")).toEqual([]);
  expect(inventory).toMatchObject({
    ok: true,
    data: {
      localStorageItems: 2,
      databases: [
        { name: "/home/web_user", version: 21 },
        { name: "progress-lab", version: 1 },
      ],
    },
  });
  // Cache Storage holds data: it is reported, never exported (save-transfer.md section 4, step 5).
  expect(exported.result).toMatchObject({ ok: true, data: { notExported: ["cacheStorage"] } });
  expect(
    exported.entries.map((e) => e.path).filter((p) => !/^(?:blobs|data\/0)\//.test(p)),
  ).toEqual([]);
  const text = exported.entries
    .map((e) => Buffer.from(e.base64, "base64").toString("latin1"))
    .join();
  expect(text).not.toContain("sid=secret");
  expect(text).not.toContain("cached bytes");
});

test("a database listed but gone when opened is skipped and not created", async ({
  page,
  lab,
  openStub,
}) => {
  await play(page, lab, 1);
  const world = await openStub(page);
  await world.call("useGhostDatabase", "ghost");
  const exported = await world.call<Exported>("exportFrame", {
    keyIndex: 0,
    storageKey: topKey(lab),
    scope: ALL,
  });
  expect(exported.result).toMatchObject({
    ok: true,
    data: { databases: [{ name: "/home/web_user" }, { name: "progress-lab" }] },
  });
  expect(
    await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort()),
  ).toEqual(["/home/web_user", "progress-lab"]);
});

test("a localStorage key that vanishes while it is read fails the export instead of exporting an empty value", async ({
  page,
  lab,
  openStub,
}) => {
  const world = await openStub(page);
  await world.call("useVanishingLocalStorage");
  const exported = await world.call<Exported>("exportFrame", {
    keyIndex: 0,
    storageKey: topKey(lab),
    scope: ALL,
  });
  expect(exported.result).toMatchObject({
    ok: false,
    error: { code: "EXP_QUIESCENCE_VIOLATION", detail: { storageKey: topKey(lab) } },
  });
  expect(exported.entries).toEqual([]);
});
