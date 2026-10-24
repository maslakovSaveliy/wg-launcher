// progress-lab: a tiny deterministic "game" whose only job is to leave verifiable progress in
// browser storage. It is not a real game. See ../README.md for the contract.
// Plain ES module, no dependencies, no network requests.

const VERSION = "1.0.0";

// localStorage
const LS_PREFIX = "progress-lab:";
const STATE_KEY = `${LS_PREFIX}state`;
const FORMAT_KEY = `${LS_PREFIX}format`;
const FORMAT = "1";

// IndexedDB: the game's own database, and one shaped like Emscripten's IDBFS mount.
const GAME_DB = { name: "progress-lab", version: 1 };
const IDBFS_DB = { name: "/home/web_user", version: 21 };
const SAVE_DIR = "/home/web_user/save";
const SAVE_FILE = `${SAVE_DIR}/slot1.dat`;
const MODE_DIR = 0o40755;
const MODE_FILE = 0o100666;

// Rules. Every timestamp is synthetic (step N happens N minutes after a fixed instant), so the
// persisted state, and therefore the hash, depends only on the number of steps.
const COINS_PER_STEP = 10;
const STEPS_PER_LEVEL = 3;
const ITEMS = ["wooden-sword", "iron-shield", "magic-ring", "golden-key", "dragon-scale"];
const FIRST_STEP_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 123);
const STEP_MS = 60_000;

const CANONICAL_FORMAT = "progress-lab/canonical-state@1";

const hashElement = document.querySelector("#progress-hash");
const errorElement = document.querySelector("#error");
const playButton = document.querySelector("#play-step");
const resetButton = document.querySelector("#reset");

// ---- State -------------------------------------------------------------------------------------

const initialState = () => ({ level: 1, coins: 0, inventory: [], steps: 0 });

const itemName = (index) =>
  `${ITEMS[index % ITEMS.length]}-${Math.floor(index / ITEMS.length) + 1}`;

function advance(state) {
  const steps = state.steps + 1;
  const levelUp = steps % STEPS_PER_LEVEL === 0;
  return {
    level: state.level + (levelUp ? 1 : 0),
    coins: state.coins + COINS_PER_STEP,
    inventory: levelUp ? [...state.inventory, itemName(state.inventory.length)] : state.inventory,
    steps,
  };
}

function parseState(json) {
  const value = JSON.parse(json);
  const valid =
    Number.isInteger(value?.level) &&
    Number.isInteger(value?.coins) &&
    Number.isInteger(value?.steps) &&
    Array.isArray(value?.inventory) &&
    value.inventory.every((item) => typeof item === "string");
  if (!valid) throw new TypeError(`${STATE_KEY} does not hold a valid state`);
  return { level: value.level, coins: value.coins, inventory: value.inventory, steps: value.steps };
}

function loadState() {
  const json = localStorage.getItem(STATE_KEY);
  return json === null ? initialState() : parseState(json);
}

const stepTime = (steps) => new Date(FIRST_STEP_MS + steps * STEP_MS);

/** Pseudo-random but fully determined bytes (xorshift32), so binary values cover 0x00 to 0xff. */
function deterministicBytes(seed, length) {
  let x = Math.imul(seed + 1, 2654435761) >>> 0 || 1;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = (bytes) => crypto.subtle.digest("SHA-256", bytes);

// ---- IndexedDB helpers -------------------------------------------------------------------------

function request(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
  });
}

function openDatabase(name, version, upgrade) {
  const opening = indexedDB.open(name, version);
  if (upgrade) opening.onupgradeneeded = () => upgrade(opening.result);
  return request(opening);
}

/** Opens a database for one piece of work and always closes it, so a wipe is never blocked. */
async function withDatabase({ name, version }, upgrade, work) {
  const db = await openDatabase(name, version, upgrade);
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

function deleteDatabase(name) {
  return request(indexedDB.deleteDatabase(name));
}

function createGameSchema(db) {
  const profile = db.createObjectStore("profile", { keyPath: "id" });
  profile.createIndex("by-level", "level", { unique: false });
  db.createObjectStore("stepLog", { autoIncrement: true });
}

// What Emscripten's IDBFS creates: one store, keyed by absolute path, with a timestamp index.
function createIdbfsSchema(db) {
  const files = db.createObjectStore("FILE_DATA");
  files.createIndex("timestamp", "timestamp", { unique: false });
}

// ---- Persisting --------------------------------------------------------------------------------

function saveFileBytes(state, digest) {
  const header = new Uint8Array(21);
  header.set([0x50, 0x4c, 0x41, 0x42]); // "PLAB"
  const view = new DataView(header.buffer);
  view.setUint8(4, 1); // layout version
  view.setUint32(5, state.level, true);
  view.setUint32(9, state.coins, true);
  view.setUint32(13, state.steps, true);
  view.setUint32(17, state.inventory.length, true);
  const bytes = new Uint8Array(header.length + digest.byteLength);
  bytes.set(header);
  bytes.set(new Uint8Array(digest), header.length);
  return bytes;
}

async function persistProgress(state) {
  const stateJson = JSON.stringify(state);
  const digest = await sha256(new TextEncoder().encode(stateJson));
  const timestamp = stepTime(state.steps);

  const profile = {
    id: "player",
    level: state.level,
    coins: state.coins,
    inventory: state.inventory,
    updatedAt: timestamp,
    checksum: digest,
    thumbnail: new Blob(
      [
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text x="4" y="32">L${state.level} ${state.coins}c</text></svg>`,
      ],
      { type: "image/svg+xml" },
    ),
  };
  const logEntry = {
    step: state.steps,
    at: timestamp,
    coinsGained: COINS_PER_STEP,
    roll: deterministicBytes(state.steps, 8),
  };
  const files = [
    ["/home/web_user", { timestamp, mode: MODE_DIR }],
    [SAVE_DIR, { timestamp, mode: MODE_DIR }],
    [SAVE_FILE, { timestamp, mode: MODE_FILE, contents: saveFileBytes(state, digest) }],
  ];

  localStorage.setItem(STATE_KEY, stateJson);
  localStorage.setItem(FORMAT_KEY, FORMAT);
  await withDatabase(GAME_DB, createGameSchema, async (db) => {
    const transaction = db.transaction(["profile", "stepLog"], "readwrite");
    transaction.objectStore("profile").put(profile);
    transaction.objectStore("stepLog").add(logEntry);
    await transactionDone(transaction);
  });
  await withDatabase(IDBFS_DB, createIdbfsSchema, async (db) => {
    const transaction = db.transaction("FILE_DATA", "readwrite");
    for (const [path, entry] of files) transaction.objectStore("FILE_DATA").put(entry, path);
    await transactionDone(transaction);
  });
}

async function wipeFixtureStorage() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(LS_PREFIX)) localStorage.removeItem(key);
  }
  await Promise.all([deleteDatabase(GAME_DB.name), deleteDatabase(IDBFS_DB.name)]);
}

// ---- Reading back and hashing ------------------------------------------------------------------

function readLocalStorage() {
  const entries = {};
  for (const key of Object.keys(localStorage).sort()) {
    if (key.startsWith(LS_PREFIX)) entries[key] = localStorage.getItem(key);
  }
  return entries;
}

async function readStore(store) {
  // Schema first and synchronously: store.index() throws once the transaction has finished.
  const indexes = [...store.indexNames].sort().map((indexName) => {
    const index = store.index(indexName);
    return {
      name: index.name,
      keyPath: index.keyPath,
      unique: index.unique,
      multiEntry: index.multiEntry,
    };
  });
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  return {
    name: store.name,
    keyPath: store.keyPath,
    autoIncrement: store.autoIncrement,
    indexes,
    records: keys.map((key, i) => ({ key, value: values[i] })),
  };
}

async function readDatabase(name) {
  const db = await openDatabase(name);
  try {
    const storeNames = [...db.objectStoreNames].sort();
    const transaction = storeNames.length > 0 ? db.transaction(storeNames, "readonly") : null;
    const stores = await Promise.all(
      storeNames.map((storeName) => readStore(transaction.objectStore(storeName))),
    );
    return { name, version: db.version, stores };
  } finally {
    db.close();
  }
}

/** Everything the fixture persisted, read back from storage. Absent databases are null. */
async function readStorage() {
  const existing = new Set((await indexedDB.databases()).map((info) => info.name));
  const databases = {};
  for (const { name } of [GAME_DB, IDBFS_DB]) {
    databases[name] = existing.has(name) ? await readDatabase(name) : null;
  }
  return { format: CANONICAL_FORMAT, localStorage: readLocalStorage(), indexedDB: databases };
}

/**
 * Deterministic JSON: object keys sorted, Date as tagged ISO, binary as tagged hex, Blob as its
 * type and bytes. A value it cannot represent is an error, never silently dropped.
 */
async function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`Cannot canonicalize the number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`Cannot canonicalize a ${typeof value}`);

  if (value instanceof Date) {
    return canonicalJson({
      $date: Number.isNaN(value.getTime()) ? "invalid" : value.toISOString(),
    });
  }
  if (value instanceof ArrayBuffer) {
    return canonicalJson({ $arraybuffer: toHex(new Uint8Array(value)) });
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return canonicalJson({ $view: value.constructor.name, hex: toHex(bytes) });
  }
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    return canonicalJson({ $blob: { type: value.type, hex: toHex(bytes) } });
  }
  if (Array.isArray(value)) {
    return `[${(await Promise.all(value.map(canonicalJson))).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Cannot canonicalize ${Object.prototype.toString.call(value)}`);
  }
  const parts = await Promise.all(
    Object.keys(value)
      .sort()
      .map(async (key) => `${JSON.stringify(key)}:${await canonicalJson(value[key])}`),
  );
  return `{${parts.join(",")}}`;
}

async function computeProgressHash() {
  const json = await canonicalJson(await readStorage());
  return toHex(new Uint8Array(await sha256(new TextEncoder().encode(json))));
}

// ---- Page --------------------------------------------------------------------------------------

let state = initialState();
let queue = Promise.resolve();
let pending = 0; // tasks queued or running, the start-up task included
let failure = null; // message of the latest failure, until a step or reset succeeds

function render() {
  document.querySelector("#level").textContent = String(state.level);
  document.querySelector("#coins").textContent = String(state.coins);
  document.querySelector("#inventory").textContent =
    state.inventory.length > 0 ? state.inventory.join(", ") : "(empty)";
}

function fail(error) {
  console.error(error);
  failure = error instanceof Error ? error.message : String(error);
}

/**
 * data-ready: "false" while any task is queued or running, so a reader never sees an intermediate
 * state as final; otherwise "error" if the latest failure is still unresolved, else "true".
 */
function syncStatus() {
  errorElement.textContent = failure ?? "";
  errorElement.hidden = failure === null;
  hashElement.dataset.ready = pending > 0 ? "false" : failure === null ? "true" : "error";
}

/** Re-reads storage and shows the state with its hash. */
async function refresh() {
  const hash = await computeProgressHash();
  render();
  hashElement.textContent = hash;
}

/**
 * Runs tasks one at a time, so quick clicks cannot interleave their storage writes. A task that
 * succeeds clears an earlier failure (`recovers`): a step or reset rewrites what was damaged.
 */
function enqueue(task, { recovers = true } = {}) {
  pending += 1;
  syncStatus();
  queue = queue
    .then(async () => {
      await task();
      if (recovers) failure = null;
    })
    .catch(fail)
    .finally(() => {
      pending -= 1;
      syncStatus();
    });
}

playButton.addEventListener("click", () =>
  enqueue(async () => {
    const next = advance(state);
    await persistProgress(next);
    state = next;
    await refresh();
  }),
);

resetButton.addEventListener("click", () =>
  enqueue(async () => {
    await wipeFixtureStorage();
    state = initialState();
    await refresh();
  }),
);

enqueue(
  async () => {
    if (new URLSearchParams(location.search).get("ephemeral") === "1") await wipeFixtureStorage();
    try {
      state = loadState();
    } catch (error) {
      // Report it, but still hash what is stored: a damaged restore should be visible in the hash.
      fail(error);
    }
    await refresh();
    playButton.disabled = false;
    resetButton.disabled = false;
  },
  { recovers: false },
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("sw.js")
    .catch((error) => console.warn("progress-lab: service worker not registered", error));
}

window.progressLab = Object.freeze({ version: VERSION });
