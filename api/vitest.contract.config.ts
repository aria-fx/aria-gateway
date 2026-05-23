import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/catalog-contract.live.ts"],
    testTimeout: 120000,
  },
});
