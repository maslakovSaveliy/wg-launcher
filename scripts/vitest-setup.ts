// Vitest setup file (vitest.config.ts `setupFiles`; it runs before the test files import anything). Plain Node 24
// prints "SQLite is an experimental feature and might change at any time" when `node:sqlite` loads, which is noise in
// the library database tests; Electron 45's Node prints no such warning (the desktop e2e records process warnings and
// expects none). Only that notice is dropped; a `--disable-warning=ExperimentalWarning` flag would hide every
// ExperimentalWarning, and the notice has no warning code to filter on.

import { dropSqliteNotice } from "./warning-filter.js";

dropSqliteNotice(process);
