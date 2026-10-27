// The build flavor, fixed at compile time by electron-vite's `define` (see electron.vite.config.ts):
// - `dev`: `electron-vite dev`, renderer from the Vite server with a looser CSP;
// - `test`: built output for the e2e suite: unfused, test hooks on (`test-hooks.ts`), userData from WG_USER_DATA;
// - `prod`: none of those. A prod bundle never contains the test hooks (checked by scripts/check-prod-bundle.mjs).

export type Flavor = "dev" | "test" | "prod";

declare global {
  /** Replaced by a string literal at build time. Compare it directly, so the bundler drops dead branches. */
  const __WG_FLAVOR__: Flavor;
}

export const FLAVOR: Flavor = __WG_FLAVOR__;
