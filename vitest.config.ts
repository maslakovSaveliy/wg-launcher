import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Spikes are throwaway and keep their own toolchain; e2e specs use *.spec.ts.
    exclude: [...configDefaults.exclude, "spikes/**"],
  },
});
