// THROWAWAY spike (runtime-compat). Not product code.
// Function declarations that main.mjs prepends to code it runs in an ISOLATED WORLD of a quiescent
// stub document (H14). Isolated worlds share the frame's storage but not its JS globals, so these
// use the real localStorage / IndexedDB API with full structured clone, and no page code is involved.
// Values are encoded as tagged JSON: every non-primitive is {$t: <type>, ...}, so nothing collides
// with a real property; an unsupported type is an explicit error, never skipped.

const WG_B64 = {
  enc(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  },
  dec(b64) {
    const text = atob(b64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  },
};

const WG_VIEWS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

function wgRequest(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function wgDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

async function wgEncode(v) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $t: "number", v: "NaN" };
    if (v === Number.POSITIVE_INFINITY) return { $t: "number", v: "Infinity" };
    if (v === Number.NEGATIVE_INFINITY) return { $t: "number", v: "-Infinity" };
    if (Object.is(v, -0)) return { $t: "number", v: "-0" };
    return v;
  }
  if (v === undefined) return { $t: "undefined" };
  if (typeof v === "bigint") return { $t: "bigint", v: v.toString() };
  if (v instanceof Date) {
    const t = v.getTime();
    return { $t: "date", v: Number.isNaN(t) ? "NaN" : t };
  }
  if (v instanceof ArrayBuffer) return { $t: "arraybuffer", b64: WG_B64.enc(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    const type = v.constructor.name;
    if (!WG_VIEWS[type]) throw new TypeError(`unsupported view ${type}`);
    return { $t: "view", type, b64: WG_B64.enc(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (typeof File !== "undefined" && v instanceof File) {
    return {
      $t: "file",
      name: v.name,
      lastModified: v.lastModified,
      type: v.type,
      b64: WG_B64.enc(new Uint8Array(await v.arrayBuffer())),
    };
  }
  if (v instanceof Blob) return { $t: "blob", type: v.type, b64: WG_B64.enc(new Uint8Array(await v.arrayBuffer())) };
  if (Array.isArray(v)) {
    const items = [];
    for (const item of v) items.push(await wgEncode(item));
    return { $t: "array", v: items };
  }
  if (v instanceof Map) {
    const entries = [];
    for (const [k, value] of v) entries.push([await wgEncode(k), await wgEncode(value)]);
    return { $t: "map", v: entries };
  }
  if (v instanceof Set) {
    const items = [];
    for (const item of v) items.push(await wgEncode(item));
    return { $t: "set", v: items };
  }
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) {
    const out = {};
    for (const key of Object.keys(v)) out[key] = await wgEncode(v[key]);
    return { $t: "object", v: out };
  }
  throw new TypeError(`unsupported value type ${Object.prototype.toString.call(v)}`);
}

function wgDecode(v) {
  if (v === null || typeof v !== "object") return v;
  switch (v.$t) {
    case "number":
      return { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, "-Infinity": Number.NEGATIVE_INFINITY, "-0": -0 }[v.v];
    case "undefined":
      return undefined;
    case "bigint":
      return BigInt(v.v);
    case "date":
      return new Date(v.v === "NaN" ? Number.NaN : v.v);
    case "arraybuffer":
      return WG_B64.dec(v.b64).buffer;
    case "view": {
      const bytes = WG_B64.dec(v.b64);
      const View = WG_VIEWS[v.type];
      if (v.type === "DataView") return new DataView(bytes.buffer);
      return new View(bytes.buffer, 0, bytes.byteLength / View.BYTES_PER_ELEMENT);
    }
    case "file":
      return new File([WG_B64.dec(v.b64)], v.name, { type: v.type, lastModified: v.lastModified });
    case "blob":
      return new Blob([WG_B64.dec(v.b64)], { type: v.type });
    case "array":
      return v.v.map(wgDecode);
    case "map":
      return new Map(v.v.map(([k, value]) => [wgDecode(k), wgDecode(value)]));
    case "set":
      return new Set(v.v.map(wgDecode));
    case "object": {
      const out = {};
      for (const key of Object.keys(v.v)) out[key] = wgDecode(v.v[key]);
      return out;
    }
    default:
      throw new TypeError(`unknown tag ${JSON.stringify(v.$t)}`);
  }
}

/** Everything the page can see about its storage and service workers, read-only. */
async function wgInventory() {
  return {
    href: location.href,
    origin: location.origin,
    stub: document.documentElement.dataset.wgStub === "1",
    scripts: document.scripts.length,
    controller: !!navigator.serviceWorker?.controller,
    registrations: navigator.serviceWorker
      ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope)
      : null,
    databases: (await indexedDB.databases()).map((d) => ({ name: d.name, version: d.version })),
    localStorageKeys: Object.keys(localStorage).sort(),
    caches: await caches.keys(),
    cookie: document.cookie,
  };
}

/** localStorage plus every IndexedDB database: schema, every record with its key. */
async function wgExport() {
  const localStorageEntries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    localStorageEntries.push([key, localStorage.getItem(key)]);
  }
  localStorageEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const infos = (await indexedDB.databases()).sort((a, b) => (a.name < b.name ? -1 : 1));
  const databases = [];
  for (const info of infos) {
    const db = await wgRequest(indexedDB.open(info.name));
    try {
      const names = [...db.objectStoreNames].sort();
      const raw = [];
      if (names.length > 0) {
        const tx = db.transaction(names, "readonly");
        const finished = wgDone(tx);
        for (const name of names) {
          const store = tx.objectStore(name);
          const indexes = [...store.indexNames].sort().map((indexName) => {
            const index = store.index(indexName);
            return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          });
          raw.push({
            name,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes,
            keys: wgRequest(store.getAllKeys()),
            values: wgRequest(store.getAll()),
          });
        }
        for (const entry of raw) {
          entry.keys = await entry.keys;
          entry.values = await entry.values;
        }
        await finished;
      }
      const stores = [];
      for (const entry of raw) {
        const records = [];
        for (let i = 0; i < entry.keys.length; i++) {
          records.push({ key: await wgEncode(entry.keys[i]), value: await wgEncode(entry.values[i]) });
        }
        stores.push({
          name: entry.name,
          keyPath: entry.keyPath,
          autoIncrement: entry.autoIncrement,
          indexes: entry.indexes,
          records,
        });
      }
      databases.push({ name: info.name, version: db.version, stores });
    } finally {
      db.close();
    }
  }
  return {
    format: "wg-spike-snapshot@1",
    origin: location.origin,
    href: location.href,
    exportedAt: new Date().toISOString(),
    localStorage: localStorageEntries,
    indexedDB: databases,
  };
}

/** Recreates databases (same version, stores, indexes) and puts every record with its own key. */
async function wgImport(snapshot) {
  const before = {
    databases: (await indexedDB.databases()).map((d) => d.name),
    localStorageKeys: Object.keys(localStorage),
  };
  if (before.databases.length > 0 || before.localStorageKeys.length > 0) {
    throw new Error(`target is not empty: ${JSON.stringify(before)}`);
  }
  for (const [key, value] of snapshot.localStorage) localStorage.setItem(key, value);
  const counts = {};
  for (const database of snapshot.indexedDB) {
    const opening = indexedDB.open(database.name, database.version);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      for (const store of database.stores) {
        const created = db.createObjectStore(store.name, {
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
        });
        for (const index of store.indexes) {
          created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      }
    };
    const db = await wgRequest(opening);
    try {
      if (database.stores.length > 0) {
        const tx = db.transaction(
          database.stores.map((s) => s.name),
          "readwrite",
        );
        const finished = wgDone(tx);
        for (const store of database.stores) {
          const target = tx.objectStore(store.name);
          for (const record of store.records) {
            const value = wgDecode(record.value);
            if (store.keyPath === null) target.put(value, wgDecode(record.key));
            else target.put(value);
          }
          counts[`${database.name}/${store.name}`] = store.records.length;
        }
        await finished;
      }
    } finally {
      db.close();
    }
  }
  return { before, counts };
}
