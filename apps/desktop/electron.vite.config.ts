// electron-vite builds three bundles: main (ESM, `dependencies` externalized and packaged), the launcher preload
// (one CommonJS bundle, everything inlined, because a sandboxed preload cannot load modules) and the React renderer.
//
// Build flavors (src/main/flavor.ts): `electron-vite dev` → dev; `electron-vite build --mode test` → test;
// `electron-vite build` → prod. `__WG_FLAVOR__` is replaced at compile time, so test-only code is dropped from prod.
//
// The dependency rule (AGENTS.md): `prodDepsGuard` fails any of the three builds that bundles a `node_modules`
// package outside the production closure of this package.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { prodDepsGuard, readProdClosure } from "../../scripts/prod-deps-guard.mjs";

const here = import.meta.dirname;
const pkgJson = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));

/** The Vite dev server origin of the dev flavor (fixed, so the dev CSP can name it). */
const DEV_SERVER = { host: "localhost", port: 5173 } as const;

/**
 * The dev flavor's CSP, sent by the Vite server. Looser than the production CSP (src/main/app-protocol.ts) only where
 * Vite needs it: the React refresh preamble is an inline script, styles are injected inline, HMR uses a WebSocket
 * to the dev server, and the Vite client builds its error overlay with innerHTML (so no Trusted Types). Never used
 * by the test or prod flavors, which load from app://launcher.
 */
const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' app://launcher",
  "font-src 'self'",
  `connect-src 'self' ws://${DEV_SERVER.host}:${DEV_SERVER.port}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig(({ command, mode }) => {
  const flavor = mode === "test" ? "test" : command === "serve" ? "dev" : "prod";
  const define = { __WG_FLAVOR__: JSON.stringify(flavor) };
  const closure = readProdClosure(here);
  const guard = () => prodDepsGuard(pkgJson, closure);

  return {
    main: {
      define,
      plugins: [guard()],
      build: {
        externalizeDeps: true,
      },
    },
    preload: {
      define,
      plugins: [guard()],
      build: {
        isolatedEntries: true,
        externalizeDeps: false,
        rolldownOptions: {
          input: { launcher: resolve(here, "src/preload/launcher.ts") },
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      define,
      plugins: [react(), guard()],
      server: {
        host: DEV_SERVER.host,
        port: DEV_SERVER.port,
        strictPort: true,
        headers: { "Content-Security-Policy": DEV_CSP },
      },
      build: {
        // Assets are always files: a data: URL would break `img-src 'self'` and `font-src 'self'`.
        assetsInlineLimit: 0,
      },
    },
  };
});
