// THROWAWAY spike (runtime-compat). Storage markers for partition isolation (H1) and persistence
// across restart (H2). The host calls window.wgStorage.write / read through executeJavaScript.
// One marker of each kind per writer id, so a reader can tell its own markers from another
// partition's: localStorage, IndexedDB (with a Blob and a Date), persistent cookie, Cache Storage,
// OPFS. With { large: true } the writer also stores a 1 MiB Blob and a 1 MiB Uint8Array in IndexedDB.

const DB = "wg-h1";
const LARGE_DB = "wg-h1-large";
const CACHE = "wg-h1";
const MIB = 1024 * 1024;
const FIXED_DATE = new Date(Date.UTC(2026, 9, 24, 12, 0, 0, 456));

const request = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
  });

function open(name, store) {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(store);
  return request(r);
}

async function existingDatabases() {
  return new Set((await indexedDB.databases()).map((d) => d.name));
}

/** xorshift32 bytes: deterministic per seed, covering 0x00..0xff. */
function bytes(seed, length) {
  let x = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function seedOf(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

async function sha256(data) {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const errorText = (e) => `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;

async function guard(fn) {
  try {
    return await fn();
  } catch (error) {
    return { error: errorText(error) };
  }
}

const cookieName = (id) => `wg_h1_${id}`;
const opfsName = (id) => `wg-h1-${id}.txt`;

async function write(id, nonce, { large = false } = {}) {
  const value = `${id}:${nonce}`;
  const out = {};
  out.localStorage = await guard(() => {
    localStorage.setItem(`wg-h1:${id}`, value);
    return { ok: true };
  });
  out.indexedDB = await guard(async () => {
    const db = await open(DB, "markers");
    try {
      const tx = db.transaction("markers", "readwrite");
      tx.objectStore("markers").put(
        { value, at: FIXED_DATE, blob: new Blob([value], { type: "text/plain" }) },
        id,
      );
      await done(tx);
    } finally {
      db.close();
    }
    return { ok: true };
  });
  out.cookie = await guard(() => {
    // Persistent (Max-Age two days): a session cookie would not survive the restart in H2.
    document.cookie = `${cookieName(id)}=${encodeURIComponent(value)}; Max-Age=172800; Path=/; SameSite=Lax`;
    return { ok: document.cookie.includes(cookieName(id)) };
  });
  out.cacheStorage = await guard(async () => {
    const cache = await caches.open(CACHE);
    await cache.put(`/wg-h1/${id}`, new Response(value, { headers: { "Content-Type": "text/plain" } }));
    return { ok: true };
  });
  out.opfs = await guard(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsName(id), { create: true });
    const writable = await handle.createWritable();
    await writable.write(value);
    await writable.close();
    return { ok: true };
  });
  if (large) {
    out.large = await guard(async () => {
      const blobBytes = bytes(seedOf(`${value}:blob`), MIB);
      const arrayBytes = bytes(seedOf(`${value}:u8`), MIB);
      const blob = new Blob([blobBytes], { type: "application/octet-stream" });
      const db = await open(LARGE_DB, "values");
      try {
        const tx = db.transaction("values", "readwrite");
        tx.objectStore("values").put(blob, `${id}:blob`);
        tx.objectStore("values").put(arrayBytes, `${id}:u8`);
        await done(tx);
      } finally {
        db.close();
      }
      return { blobSha256: await sha256(blobBytes), u8Sha256: await sha256(arrayBytes) };
    });
  }
  return out;
}

async function readOne(id, { large = false } = {}) {
  const out = {};
  out.localStorage = await guard(() => localStorage.getItem(`wg-h1:${id}`));
  out.indexedDB = await guard(async () => {
    if (!(await existingDatabases()).has(DB)) return null;
    const db = await open(DB, "markers");
    try {
      const record = await request(db.transaction("markers").objectStore("markers").get(id));
      if (record === undefined) return null;
      return {
        value: record.value,
        dateIsDate: record.at instanceof Date,
        date: record.at instanceof Date ? record.at.toISOString() : null,
        blobType: record.blob instanceof Blob ? record.blob.type : null,
        blobText: record.blob instanceof Blob ? await record.blob.text() : null,
      };
    } finally {
      db.close();
    }
  });
  out.cookie = await guard(() => {
    const pair = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${cookieName(id)}=`));
    return pair ? decodeURIComponent(pair.slice(cookieName(id).length + 1)) : null;
  });
  out.cacheStorage = await guard(async () => {
    if (!(await caches.has(CACHE))) return null;
    const cache = await caches.open(CACHE);
    const response = await cache.match(`/wg-h1/${id}`);
    return response ? await response.text() : null;
  });
  out.opfs = await guard(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      const handle = await root.getFileHandle(opfsName(id));
      return await (await handle.getFile()).text();
    } catch (error) {
      if (error.name === "NotFoundError") return null;
      throw error;
    }
  });
  if (large) {
    out.large = await guard(async () => {
      if (!(await existingDatabases()).has(LARGE_DB)) return null;
      const db = await open(LARGE_DB, "values");
      try {
        const store = db.transaction("values").objectStore("values");
        const [blob, u8] = await Promise.all([
          request(store.get(`${id}:blob`)),
          request(store.get(`${id}:u8`)),
        ]);
        return {
          blobIsBlob: blob instanceof Blob,
          blobSize: blob instanceof Blob ? blob.size : null,
          blobSha256: blob instanceof Blob ? await sha256(blob) : null,
          u8IsUint8Array: u8 instanceof Uint8Array,
          u8Length: u8 instanceof Uint8Array ? u8.length : null,
          u8Sha256: u8 instanceof Uint8Array ? await sha256(u8) : null,
        };
      } finally {
        db.close();
      }
    });
  }
  return out;
}

async function read(ids, options) {
  const out = {};
  for (const id of ids) out[id] = await readOne(id, options);
  out.origin = location.origin;
  return out;
}

window.wgStorage = Object.freeze({ write, read });
document.querySelector("#status").textContent = "ready";
