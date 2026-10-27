// Every native dialog of the main process goes through this interface. Production uses Electron's dialogs; the
// test flavor substitutes answers queued by the e2e suite (test-hooks.ts). No dialog is ever skipped in prod.

import { type BrowserWindow, dialog } from "electron";

export interface ConfirmSpec {
  title: string;
  message: string;
  /** What will be lost or changed, in plain words. */
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileSpec {
  title: string;
  filters?: FileFilter[];
}

export interface SaveFileSpec {
  title: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface Dialogs {
  /** Resolves true only when the user chose the confirm button; cancel is the default. */
  confirm(spec: ConfirmSpec): Promise<boolean>;
  openFile(spec: OpenFileSpec): Promise<string | null>;
  saveFile(spec: SaveFileSpec): Promise<string | null>;
}

/** Electron's native dialogs, modal to the window `parent` returns when there is one. */
export function nativeDialogs(parent: () => BrowserWindow | null): Dialogs {
  return {
    async confirm(spec) {
      const options = {
        type: "question" as const,
        title: spec.title,
        message: spec.message,
        detail: spec.detail ?? "",
        buttons: [spec.cancelLabel ?? "Cancel", spec.confirmLabel],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const window = parent();
      const { response } = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return response === 1;
    },
    async openFile(spec) {
      const options = {
        title: spec.title,
        filters: spec.filters ?? [],
        properties: ["openFile" as const],
      };
      const window = parent();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async saveFile(spec) {
      const options = {
        title: spec.title,
        filters: spec.filters ?? [],
        ...(spec.defaultPath === undefined ? {} : { defaultPath: spec.defaultPath }),
      };
      const window = parent();
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
  };
}
