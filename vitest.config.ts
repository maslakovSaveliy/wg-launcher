import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Spikes are throwaway and keep their own toolchain; e2e specs use *.spec.ts.
    exclude: [...configDefaults.exclude, "spikes/**"],
    // `node:sqlite` is a release candidate in Node 24 and prints an ExperimentalWarning when first loaded (the
    // desktop database tests run in plain Node; Electron 45's Node prints none). The warning has no code, so the
    // test workers skip that warning type; every other warning still prints.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
