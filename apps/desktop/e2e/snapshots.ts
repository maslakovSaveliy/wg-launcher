// Helpers for the snapshot e2e specs: drive exports and storage checks through the test hooks, read the `.wgsnap`
// files the app wrote with the real validator, and list what is left in `snapshots/` and `tmp/`.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorCode, Result } from "@wg-launcher/shared";
import {
  readEntries,
  type ValidatedSnapshot,
  validateSnapshot,
} from "@wg-launcher/snapshot/container";
import type { Snapshot } from "../src/main/db/repos/snapshots.js";
import type { StorageCheck } from "../src/main/db/repos/storage-checks.js";
import type { ExportTestControls } from "../src/main/snapshots/export.js";
import type { StorageKeyRef } from "../src/main/snapshots/keys.js";
import type { QuiescentControl } from "../src/main/test-hooks.js";
import type { Launched } from "./harness.js";

export function exportSnapshot(
  launched: Launched,
  gameId: string,
  options: { frameKeys?: StorageKeyRef[]; test?: ExportTestControls } = {},
): Promise<Result<Snapshot, ErrorCode>> {
  return launched.app.evaluate(
    (_electron, [id, opts]) =>
      globalThis.__wgTest?.exportSnapshot(id as string, opts as never) as Promise<
        Result<Snapshot, ErrorCode>
      >,
    [gameId, options] as const,
  );
}

export function runStorageCheck(
  launched: Launched,
  gameId: string,
): Promise<Result<StorageCheck, ErrorCode>> {
  return launched.app.evaluate(
    (_electron, id) =>
      globalThis.__wgTest?.runStorageCheck(id) as Promise<Result<StorageCheck, ErrorCode>>,
    gameId,
  );
}

export function setQuiescentControl(launched: Launched, control: QuiescentControl): Promise<void> {
  return launched.app.evaluate(
    (_electron, value) => globalThis.__wgTest?.setQuiescentControl(value as QuiescentControl),
    control,
  );
}

export function snapshotRows(launched: Launched, gameId: string): Promise<Snapshot[]> {
  return launched.app.evaluate(
    (_electron, id) => globalThis.__wgTest?.snapshotRows(id) ?? [],
    gameId,
  );
}

/** The file of a stored row, validated by the real reader (Node, here in the test process). */
export async function validated(launched: Launched, row: Snapshot): Promise<ValidatedSnapshot> {
  const file = join(launched.userData, row.path);
  const { size } = await stat(file);
  return validateSnapshot(createReadStream(file), { compressedSize: size });
}

/** Every entry of a stored row's file, whole (the restore's streaming pass, used here to look inside). */
export async function entriesOf(
  launched: Launched,
  row: Snapshot,
): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const file = join(launched.userData, row.path);
  const { size } = await stat(file);
  const { manifest } = await validated(launched, row);
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  for await (const entry of readEntries(createReadStream(file), manifest, {
    compressedSize: size,
  })) {
    entries.push({ path: entry.path, bytes: entry.bytes });
  }
  return entries;
}

/** The files in `tmp/` and in `snapshots/<gameId>/` (absent counts as empty). */
export async function leftovers(launched: Launched, gameId: string) {
  const list = (dir: string) => readdir(dir).catch(() => [] as string[]);
  return {
    tmp: await list(join(launched.userData, "tmp")),
    snapshots: await list(join(launched.userData, "snapshots", gameId)),
  };
}

type Hooks = NonNullable<typeof globalThis.__wgTest>;

/** Calls one async test hook in the app with JSON arguments. */
function call<K extends keyof Hooks>(
  launched: Launched,
  name: K,
  ...args: unknown[]
): Promise<Awaited<ReturnType<Extract<Hooks[K], (...a: never[]) => unknown>>>> {
  return launched.app.evaluate(
    (_electron, [hook, values]) =>
      (globalThis.__wgTest as unknown as Record<string, (...a: unknown[]) => unknown>)[
        hook as string
      ]?.(...(values as unknown[])),
    [name, args] as const,
  ) as never;
}

export const restoreSnapshot = (
  launched: Launched,
  gameId: string,
  options: Parameters<Hooks["restoreSnapshot"]>[1],
) => call(launched, "restoreSnapshot", gameId, options);
export const setFaults = (launched: Launched, specs: string[]) =>
  call(launched, "setFaults", specs);
export const deleteLocalSaves = (launched: Launched, gameId: string) =>
  call(launched, "deleteLocalSaves", gameId);
export const clearCache = (launched: Launched, gameId: string) =>
  call(launched, "clearCache", gameId);
export const verifySnapshot = (launched: Launched, gameId: string, revisionId: string) =>
  call(launched, "verifySnapshot", gameId, revisionId);
export const retryRecovery = (launched: Launched, gameId: string) =>
  call(launched, "retryRecovery", gameId);
export const journalOf = (launched: Launched, gameId: string) =>
  call(launched, "journalOf", gameId);
export const gameRow = (launched: Launched, gameId: string) => call(launched, "gameRow", gameId);
export const storageDigest = (launched: Launched, gameId: string) =>
  call(launched, "storageDigest", gameId);
export const storageInventory = (launched: Launched, gameId: string, entryUrl?: string) =>
  call(launched, "storageInventory", gameId, entryUrl);
export const recoveryDone = (launched: Launched) =>
  launched.app.evaluate(() => globalThis.__wgTest?.recoveryDone ?? false);

/** Unwraps a result or fails the test with its code and message. */
export const ok = <T>(
  result: { ok: true; data: T } | { ok: false; code: string; message: string },
): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
};
