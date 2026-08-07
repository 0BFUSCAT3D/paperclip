import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "static-replay.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command:
      "pnpm exec vite preview --config vite.config.ts --host 127.0.0.1 --port 4179",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
