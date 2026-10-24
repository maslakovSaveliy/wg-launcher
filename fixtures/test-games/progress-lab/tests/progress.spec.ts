import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Frame, type Locator } from "@playwright/test";

// Contract constants, documented in README.md.
const COINS_PER_STEP = 10;
const SERVER_FILE = fileURLToPath(new URL("../server.mjs", import.meta.url));
const GAME_DB = "progress-lab";
const IDBFS_DB = "/home/web_user";
const SAVE_PATH = "/home/web_user/save/slot1.dat";
const STEP_ZERO_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 123);

interface Origins {
  /** Origin the project is configured with (`localhost`). */
  local: string;
  /** The same server on another site (`127.0.0.1`). */
  loopback: string;
  port: number;
}

const test = base.extend<{ origins: Origins; expectedErrors: RegExp[] }>({
  // Console errors a test provokes on purpose (`test.use({ expectedErrors: [...] })`).
  expectedErrors: [[], { option: true }],
  origins: async ({ baseURL }, use) => {
    if (!baseURL) throw new Error("baseURL is not configured");
    const url = new URL(baseURL);
    await use({
      local: url.origin,
      loopback: `${url.protocol}//127.0.0.1:${url.port}`,
      port: Number(url.port),
    });
  },
  // Every test fails on uncaught page errors and console errors, so a broken game cannot pass.
  page: async ({ page, expectedErrors }, use) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
    });
    await use(page);
    expect(problems.filter((problem) => !expectedErrors.some((re) => re.test(problem)))).toEqual(
      [],
    );
  },
});

/** Page and FrameLocator both satisfy this, so the same helpers drive a top-level or framed game. */
interface Scope {
  locator(selector: string): Locator;
}

function game(scope: Scope) {
  const hash = scope.locator("#progress-hash");
  const coins = scope.locator("#coins");

  const ready = async (): Promise<string> => {
    await expect(hash).toHaveAttribute("data-ready", "true");
    await expect(hash).toHaveText(/^[0-9a-f]{64}$/);
    return (await hash.textContent()) ?? "";
  };

  return {
    hash,
    coins,
    level: scope.locator("#level"),
    inventory: scope.locator("#inventory"),
    error: scope.locator("#error"),
    reset: scope.locator("#reset"),
    ready,
    /** Clicks "Play step" `steps` times, waiting for each step to be saved and read back. */
    async play(steps: number): Promise<void> {
      await ready();
      const start = Number(await coins.textContent());
      for (let step = 1; step <= steps; step++) {
        await scope.locator("#play-step").click();
        await expect(coins).toHaveText(String(start + step * COINS_PER_STEP));
      }
      await ready();
    },
  };
}

// A raw view of everything the origin stores, built in the page with the real storage APIs and
// independent of the game's own hashing code. Binary and Date values keep a type tag so the tests
// can assert types and not only values.
interface StoreDump {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: string[];
  records: { key: unknown; value: Record<string, unknown> }[];
}
interface StorageDump {
  localStorage: Record<string, string>;
  databases: Record<string, { version: number; stores: Record<string, StoreDump> }>;
}

async function dumpStorage(frame: Frame): Promise<StorageDump> {
  return await frame.evaluate(async () => {
    const tagged = async (value: unknown): Promise<unknown> => {
      if (value instanceof Date)
        return { $type: "Date", iso: value.toISOString(), ms: value.getTime() };
      if (value instanceof ArrayBuffer) {
        return { $type: "ArrayBuffer", bytes: [...new Uint8Array(value)] };
      }
      if (value instanceof Uint8Array) return { $type: "Uint8Array", bytes: [...value] };
      if (value instanceof Blob) {
        const bytes = [...new Uint8Array(await value.arrayBuffer())];
        return { $type: "Blob", mime: value.type, bytes };
      }
      if (Array.isArray(value)) return await Promise.all(value.map(tagged));
      if (value !== null && typeof value === "object") {
        const entries = await Promise.all(
          Object.entries(value).map(async ([key, entry]) => [key, await tagged(entry)] as const),
        );
        return Object.fromEntries(entries);
      }
      return value;
    };
    const request = <T>(req: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

    const localStorageDump: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) localStorageDump[key] = localStorage.getItem(key) ?? "";
    }

    const databases: StorageDump["databases"] = {};
    for (const info of await indexedDB.databases()) {
      if (info.name === undefined) continue;
      const db = await request(indexedDB.open(info.name));
      const stores: Record<string, StoreDump> = {};
      for (const name of db.objectStoreNames) {
        const store = db.transaction(name, "readonly").objectStore(name);
        const [keys, values] = await Promise.all([
          request(store.getAllKeys()),
          request(store.getAll()),
        ]);
        stores[name] = {
          keyPath: store.keyPath as string | string[] | null,
          autoIncrement: store.autoIncrement,
          indexes: [...store.indexNames],
          records: await Promise.all(
            keys.map(async (key, i) => ({
              key: await tagged(key),
              value: (await tagged(values[i])) as Record<string, unknown>,
            })),
          ),
        };
      }
      databases[info.name] = { version: db.version, stores };
      db.close();
    }
    return { localStorage: localStorageDump, databases };
  });
}

/** Flips the last byte of the Emscripten-style save file straight in IndexedDB, bypassing the game. */
async function flipSaveByte(frame: Frame): Promise<void> {
  await frame.evaluate(
    async ({ dbName, path }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("FILE_DATA", "readwrite");
      const store = tx.objectStore("FILE_DATA");
      const get = store.get(path);
      get.onsuccess = () => {
        const record = get.result;
        record.contents[record.contents.length - 1] ^= 0xff;
        store.put(record, path);
      };
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: IDBFS_DB, path: SAVE_PATH },
  );
}

function recordsOf(dump: StorageDump, db: string, store: string) {
  const records = dump.databases[db]?.stores[store]?.records;
  if (!records) throw new Error(`${db}/${store} is missing from the storage dump`);
  return records;
}

function bytesOf(described: unknown): number[] {
  const bytes = (described as { bytes?: unknown } | null)?.bytes;
  if (!Array.isArray(bytes)) throw new Error("not a described binary value");
  return bytes as number[];
}

test("persists progress across reload", async ({ page }) => {
  await page.goto("/");
  const g = game(page);
  const emptyHash = await g.ready();

  // Four steps cross the first level boundary (every third step), so level and inventory change too.
  await g.play(4);
  const hash = await g.ready();
  expect(hash).not.toBe(emptyHash);
  await expect(g.coins).toHaveText("40");
  await expect(g.level).toHaveText("2");
  const inventory = (await g.inventory.textContent()) ?? "";
  expect(inventory.trim()).not.toBe("");

  await page.reload();
  expect(await g.ready()).toBe(hash);
  await expect(g.coins).toHaveText("40");
  await expect(g.level).toHaveText("2");
  await expect(g.inventory).toHaveText(inventory);
  await expect(g.error).toBeHidden();

  // A new tab of the same browser context reads the same persisted state.
  const second = await page.context().newPage();
  await second.goto("/");
  expect(await game(second).ready()).toBe(hash);
});

test("ephemeral mode loses progress", async ({ page }) => {
  await page.goto("/?ephemeral=1");
  const g = game(page);
  const emptyHash = await g.ready();
  await g.play(3);
  const playedHash = await g.ready();
  expect(playedHash).not.toBe(emptyHash);

  // Ephemeral mode wipes on load. It does not refuse to save, so a normal load still sees the progress.
  await page.goto("/");
  expect(await g.ready()).toBe(playedHash);

  await page.goto("/?ephemeral=1");
  expect(await g.ready()).toBe(emptyHash);
  await expect(g.coins).toHaveText("0");
  const dump = await dumpStorage(page.mainFrame());
  expect(dump.localStorage).toEqual({});
  expect(dump.databases).toEqual({});
});

test("binary values roundtrip byte-equal and Date type preserved", async ({ page }) => {
  await page.goto("/");
  const g = game(page);
  await g.play(4);
  const before = await dumpStorage(page.mainFrame());

  await page.reload();
  await g.ready();
  const after = await dumpStorage(page.mainFrame());
  expect(after).toEqual(before);

  // Types survive, not only values. Expected values are computed here, not read from the game.
  const state = after.localStorage["progress-lab:state"] ?? "";
  const stateDigest = [...createHash("sha256").update(state).digest()];

  const [profile] = recordsOf(after, GAME_DB, "profile");
  expect(profile?.value).toMatchObject({
    id: "player",
    updatedAt: { $type: "Date", ms: STEP_ZERO_MS + 4 * 60_000 },
    checksum: { $type: "ArrayBuffer" },
    thumbnail: { $type: "Blob", mime: "image/svg+xml" },
  });
  expect(bytesOf(profile?.value.checksum)).toEqual(stateDigest);
  expect(Buffer.from(bytesOf(profile?.value.thumbnail)).toString("utf8")).toContain("<svg");

  const log = recordsOf(after, GAME_DB, "stepLog");
  expect(log.map((record) => record.key)).toEqual([1, 2, 3, 4]);
  log.forEach((record, index) => {
    expect(record.value).toMatchObject({
      step: index + 1,
      at: { $type: "Date", ms: STEP_ZERO_MS + (index + 1) * 60_000 },
      roll: { $type: "Uint8Array" },
    });
    expect(bytesOf(record.value.roll)).toHaveLength(8);
  });

  const file = recordsOf(after, IDBFS_DB, "FILE_DATA").find((record) => record.key === SAVE_PATH);
  expect(file?.value).toMatchObject({
    mode: 0o100666,
    timestamp: { $type: "Date" },
    contents: { $type: "Uint8Array" },
  });
  const contents = bytesOf(file?.value.contents);
  expect(Buffer.from(contents.slice(0, 4)).toString("ascii")).toBe("PLAB");
  expect(contents.slice(-32)).toEqual(stateDigest);

  // Shape of the stores that a snapshot has to carry.
  expect(after.databases[GAME_DB]?.stores.profile).toMatchObject({
    keyPath: "id",
    autoIncrement: false,
    indexes: ["by-level"],
  });
  expect(after.databases[GAME_DB]?.stores.stepLog).toMatchObject({
    keyPath: null,
    autoIncrement: true,
  });
  expect(after.databases[IDBFS_DB]).toMatchObject({
    version: 21,
    stores: { FILE_DATA: { keyPath: null, autoIncrement: false, indexes: ["timestamp"] } },
  });
});

test("cross-site iframe storage is partitioned", async ({ page, origins }) => {
  const embed = (host: string) =>
    `${host}/iframe-host.html?src=${encodeURIComponent(`${origins.loopback}/`)}`;

  // Progress made at the top level of the 127.0.0.1 site.
  await page.goto(`${origins.loopback}/`);
  const top = game(page);
  const emptyHash = await top.ready();
  await top.play(3);
  const topHash = await top.ready();
  expect(topHash).not.toBe(emptyHash);

  // Control: the same origin embedded by a same-site host shares that storage. Without this the
  // assertions below could not fail.
  await page.goto(embed(origins.loopback));
  const framed = game(page.frameLocator("#game-frame"));
  expect(await framed.ready()).toBe(topHash);

  // The same origin embedded cross-site (host on localhost) gets its own, empty partition.
  await page.goto(embed(origins.local));
  expect(await framed.ready()).toBe(emptyHash);
  await expect(framed.coins).toHaveText("0");

  await framed.play(2);
  const framedHash = await framed.ready();
  expect(framedHash).not.toBe(emptyHash);
  expect(framedHash).not.toBe(topHash);

  // That partition persists, and the top-level storage was never touched.
  await page.reload();
  expect(await framed.ready()).toBe(framedHash);
  await page.goto(`${origins.loopback}/`);
  expect(await top.ready()).toBe(topHash);
  await expect(top.coins).toHaveText("30");
});

test("reset clears all fixture storage", async ({ page }) => {
  await page.goto("/");
  const g = game(page);
  const emptyHash = await g.ready();
  await g.play(4);
  expect(await g.ready()).not.toBe(emptyHash);

  await g.reset.click();
  await expect(g.coins).toHaveText("0");
  expect(await g.ready()).toBe(emptyHash);
  const empty = { localStorage: {}, databases: {} };
  expect(await dumpStorage(page.mainFrame())).toEqual(empty);

  await page.reload();
  expect(await g.ready()).toBe(emptyHash);
  expect(await dumpStorage(page.mainFrame())).toEqual(empty);
});

test("the hash depends only on the persisted state", async ({ page, browser, origins }) => {
  await page.goto("/");
  const g = game(page);
  await g.play(3);
  const hash = await g.ready();

  // A second, independent browser context makes the same three steps and gets the same hash.
  const other = await browser.newContext({ baseURL: origins.local });
  try {
    const otherPage = await other.newPage();
    await otherPage.goto("/");
    const otherGame = game(otherPage);
    await otherGame.play(3);
    expect(await otherGame.ready()).toBe(hash);
    await otherGame.play(1);
    expect(await otherGame.ready()).not.toBe(hash);
  } finally {
    await other.close();
  }
});

test("the hash is read back from storage", async ({ page }) => {
  await page.goto("/");
  const g = game(page);
  await g.play(3);
  const hash = await g.ready();

  // Change one stored byte behind the game's back. Memory is rebuilt on reload, so only a hash that
  // is read back from IndexedDB can notice.
  await flipSaveByte(page.mainFrame());
  await page.reload();
  expect(await g.ready()).not.toBe(hash);
  await expect(g.coins).toHaveText("30");

  await flipSaveByte(page.mainFrame());
  await page.reload();
  expect(await g.ready()).toBe(hash);
});

interface Observed {
  ready: string | null;
  coins: string | null;
  hash: string;
}

/**
 * Clicks the buttons back to back in one task, then records every state of `#progress-hash` and
 * `#coins` until `data-ready` is "true" with `finalCoins` shown. A MutationObserver sees states a
 * polling assertion could miss.
 */
async function clickAndObserve(
  frame: Frame,
  buttons: string[],
  finalCoins: string,
): Promise<Observed[]> {
  return await frame.evaluate(
    ({ buttons, finalCoins }) =>
      new Promise<Observed[]>((resolve, reject) => {
        const hash = document.querySelector<HTMLElement>("#progress-hash");
        const coins = document.querySelector("#coins");
        if (!hash || !coins) return reject(new Error("the game elements are missing"));
        const observed: Observed[] = [];
        const observer = new MutationObserver(() => {
          const entry = {
            ready: hash.dataset.ready ?? null,
            coins: coins.textContent,
            hash: hash.textContent ?? "",
          };
          observed.push(entry);
          if (entry.ready === "true" && entry.coins === finalCoins) {
            observer.disconnect();
            resolve(observed);
          }
        });
        observer.observe(hash, { attributes: true, childList: true, characterData: true });
        observer.observe(coins, { childList: true, characterData: true });
        for (const selector of buttons) document.querySelector<HTMLElement>(selector)?.click();
      }),
    { buttons, finalCoins },
  );
}

test("data-ready stays false until every queued step is saved", async ({
  page,
  browser,
  origins,
}) => {
  await page.goto("/");
  const g = game(page);
  await g.ready();

  const observed = await clickAndObserve(page.mainFrame(), ["#play-step", "#play-step"], "20");
  expect(observed.some((entry) => entry.ready === "false")).toBe(true);

  // Whenever the game says it is ready, it already shows the result of both steps.
  const ready = observed.filter((entry) => entry.ready === "true");
  expect(ready.length).toBeGreaterThan(0);
  expect(ready.map((entry) => entry.coins)).toEqual(ready.map(() => "20"));
  const finalHash = await g.ready();
  expect(ready.map((entry) => entry.hash)).toEqual(ready.map(() => finalHash));

  // And that result is what two separate steps give in an independent session.
  const other = await browser.newContext({ baseURL: origins.local });
  try {
    const otherPage = await other.newPage();
    await otherPage.goto("/");
    const otherGame = game(otherPage);
    await otherGame.play(2);
    expect(await otherGame.ready()).toBe(finalHash);
  } finally {
    await other.close();
  }
});

test("data-ready stays false until a step followed by a reset is done", async ({ page }) => {
  await page.goto("/");
  const g = game(page);
  const emptyHash = await g.ready();
  await g.play(2);

  const observed = await clickAndObserve(page.mainFrame(), ["#play-step", "#reset"], "0");
  expect(observed.some((entry) => entry.ready === "false")).toBe(true);

  const ready = observed.filter((entry) => entry.ready === "true");
  expect(ready.length).toBeGreaterThan(0);
  expect(ready.map((entry) => entry.coins)).toEqual(ready.map(() => "0"));
  expect(ready.map((entry) => entry.hash)).toEqual(ready.map(() => emptyHash));
  expect(await dumpStorage(page.mainFrame())).toEqual({ localStorage: {}, databases: {} });
});

test.describe("damaged saved state", () => {
  test.use({ expectedErrors: [/progress-lab:state does not hold a valid state/] });

  test("is reported until a step or reset succeeds", async ({ page }) => {
    await page.goto("/");
    const g = game(page);
    const emptyHash = await g.ready();

    for (const recovery of ["#play-step", "#reset"]) {
      await page.evaluate(() => localStorage.setItem("progress-lab:state", '{"level":"one"}'));
      await page.reload();

      // The load failure stays reported, and the damage still shows in the hash.
      await expect(g.hash).toHaveAttribute("data-ready", "error");
      await expect(g.error).toBeVisible();
      await expect(g.error).toContainText("does not hold a valid state");
      await expect(g.hash).toHaveText(/^[0-9a-f]{64}$/);
      expect(await g.hash.textContent()).not.toBe(emptyHash);

      await page.locator(recovery).click();
      await expect(g.hash).toHaveAttribute("data-ready", "true");
      await expect(g.error).toBeHidden();
      if (recovery === "#play-step") {
        await expect(g.coins).toHaveText("10");
      } else {
        await expect(g.coins).toHaveText("0");
        expect(await g.ready()).toBe(emptyHash);
      }
    }
  });
});

test("coi path is cross-origin isolated", async ({ page }) => {
  const plain = await page.goto("/");
  expect(plain?.headers()["cross-origin-opener-policy"]).toBeUndefined();
  expect(plain?.headers()["cross-origin-embedder-policy"]).toBeUndefined();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);

  const isolated = await page.goto("/coi/");
  expect(isolated?.headers()).toMatchObject({
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
  });
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe("function");

  // The game itself still works under COOP and COEP.
  const g = game(page);
  await g.play(1);
  await expect(g.coins).toHaveText("10");
});

test("service worker controls the page after reload", async ({ page, origins }) => {
  await page.goto("/");
  await game(page).ready();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(`${origins.local}/`);

  const gameScript = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/game.js",
  );
  await page.reload();
  expect((await gameScript).fromServiceWorker()).toBe(true);
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  const precached = await page.evaluate(async () => {
    const [name] = await caches.keys();
    if (name === undefined) return [];
    const cache = await caches.open(name);
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
  expect(precached).toEqual(expect.arrayContaining(["/", "/index.html", "/game.js"]));

  // Saving still works while the page is served from the worker's cache.
  const g = game(page);
  await g.play(1);
  await expect(g.coins).toHaveText("10");
});

test("iframe host embeds only http and https urls", async ({ page, origins }) => {
  const frame = page.locator("#game-frame");
  const error = page.locator("#host-error");

  for (const src of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/hosts",
    "not a url",
    "",
  ]) {
    await page.goto(`/iframe-host.html?src=${encodeURIComponent(src)}`);
    await expect(error).toBeVisible();
    await expect(frame).not.toHaveAttribute("src", /.+/);
  }

  await page.goto(`/iframe-host.html?src=${encodeURIComponent(`${origins.loopback}/`)}`);
  await expect(error).toBeHidden();
  await expect(frame).toHaveAttribute("src", `${origins.loopback}/`);
});

function rawGet(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    // node:http sends `path` byte for byte, unlike fetch, which would collapse `..` segments.
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("server refuses path traversal", async ({ origins }) => {
  // Control: a file inside public/ is served, so a refusal below is not just a dead server.
  expect((await rawGet(origins.port, "/index.html")).status).toBe(200);

  const attempts = [
    "/../package.json",
    "/../server.mjs",
    "/./../package.json",
    "//../package.json",
    "/%2e%2e/package.json",
    "/%2E%2E/package.json",
    "/..%2fpackage.json",
    "/%2e%2e%2fpackage.json",
    "/..%5cpackage.json",
    "/%252e%252e/package.json",
    "/coi/../package.json",
    "/coi/%2e%2e/package.json",
    "/index.html%00.js",
  ];
  for (const path of attempts) {
    const { status, body } = await rawGet(origins.port, path);
    expect([403, 404, 400], path).toContain(status);
    expect(body, path).not.toContain("fixture-progress-lab");
    expect(body, path).not.toContain("createServer");
  }
});

test("server serves both loopback hosts with the right content types", async ({
  request,
  origins,
}) => {
  for (const origin of [origins.local, origins.loopback]) {
    const page = await request.get(`${origin}/`);
    expect(page.status(), origin).toBe(200);
    expect(page.headers()["content-type"], origin).toContain("text/html");
    const script = await request.get(`${origin}/game.js`);
    expect(script.headers()["content-type"], origin).toContain("text/javascript");
  }
});

test("server logs every request to stdout", async () => {
  const probe = createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve((probe.address() as { port: number }).port));
  });
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, [SERVER_FILE, "--port", String(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  try {
    await expect.poll(() => output).toContain("listening");
    await rawGet(port, "/game.js");
    await rawGet(port, "/missing");
    await expect.poll(() => output).toMatch(/GET \S+ \/game\.js 200$/m);
    await expect.poll(() => output).toMatch(/GET \S+ \/missing 404$/m);
  } finally {
    child.kill();
  }
});

test("server exits with a usage error without a valid --port", async () => {
  for (const args of [[], ["--port", "nope"], ["--port", "0"], ["--port", "70000"]]) {
    const result = spawnSync(process.execPath, [SERVER_FILE, ...args], { encoding: "utf8" });
    expect(result.status, args.join(" ")).toBe(2);
    expect(result.stderr, args.join(" ")).toContain("Usage");
  }
});
