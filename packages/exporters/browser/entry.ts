// Test-only bundle entry, evaluated in an isolated world of the stub page (browser/harness.ts). It wraps the exporter
// with the real Web APIs of that world and moves bytes as base64, because CDP returns JSON. Not product code: Task 13's
// quiescent preload is the real caller.
import {
  createFrameExporter,
  type EntrySource,
  type FrameEnv,
  type FrameExportRequest,
  type FrameImportPlan,
  type FrameScope,
} from "../src/index.js";

export interface WireEntry {
  path: string;
  base64: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function realEnv(overrides: Partial<FrameEnv> = {}): FrameEnv {
  return { localStorage, indexedDB, crypto, storage: navigator.storage, ...overrides };
}

let fakeLocalStorage: Storage | undefined;

/** A localStorage whose setItem throws QuotaExceededError after `room` items, as a full quota would. */
export function useQuotaLocalStorage(room: number): void {
  const items = new Map<string, string>();
  fakeLocalStorage = {
    get length() {
      return items.size;
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (items.size >= room) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
}

let ghostDatabase: string | undefined;

/** Makes `indexedDB.databases()` list a database that does not exist, as one deleted after the listing would be. */
export function useGhostDatabase(name: string): void {
  ghostDatabase = name;
}

function factory(): IDBFactory {
  const ghost = ghostDatabase;
  if (ghost === undefined) {
    return indexedDB;
  }
  return new Proxy(indexedDB, {
    get(target, property) {
      if (property === "databases") {
        return async () => [...(await target.databases()), { name: ghost, version: 1 }];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const env = () =>
  realEnv({
    indexedDB: factory(),
    ...(fakeLocalStorage === undefined ? {} : { localStorage: fakeLocalStorage }),
  });

/** Records any read of a credential or cache API in this world; the exporter must never touch them (AC-20). */
export function spyOnCredentials(): string[] {
  const touched: string[] = [];
  const trap = (target: object, name: string) => {
    const proto = Object.getPrototypeOf(target) as object;
    const owner = name in target && Object.hasOwn(target, name) ? target : proto;
    const original = Object.getOwnPropertyDescriptor(owner, name);
    Object.defineProperty(owner, name, {
      configurable: true,
      get() {
        touched.push(name);
        return original?.get?.call(this) ?? original?.value;
      },
      set(value: unknown) {
        touched.push(`${name}=`);
        original?.set?.call(this, value);
      },
    });
  };
  trap(Document.prototype, "cookie");
  for (const name of ["cookieStore", "caches"]) {
    trap(window, name);
  }
  for (const name of ["credentials", "serviceWorker"]) {
    trap(navigator, name);
  }
  return touched;
}

export async function inventory() {
  return createFrameExporter(env()).inventory();
}

export async function exportFrame(request: FrameExportRequest) {
  const entries: WireEntry[] = [];
  const result = await createFrameExporter(env()).exportFrame(request, {
    write: async (path, bytes) => {
      entries.push({ path, base64: toBase64(bytes) });
    },
  });
  return { result, entries };
}

export async function importFrame(entries: WireEntry[], plan: FrameImportPlan) {
  async function* source(): EntrySource {
    for (const entry of entries) {
      yield { path: entry.path, bytes: fromBase64(entry.base64) };
    }
  }
  return createFrameExporter(env()).importFrame(source(), plan);
}

export async function wipeSelected(scope: FrameScope) {
  return createFrameExporter(env()).wipeSelected(scope);
}
