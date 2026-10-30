import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // Spikes are throwaway and keep their own toolchain; e2e specs use *.spec.ts.
    exclude: [...configDefaults.exclude, "spikes/**"],
    // Drops node:sqlite's ExperimentalWarning notice from plain Node 24 only (see the file).
    setupFiles: ["scripts/vitest-setup.ts"],
  },
});
