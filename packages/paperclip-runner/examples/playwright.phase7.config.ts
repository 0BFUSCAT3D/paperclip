import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /phase7-(explorer|chat)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4193",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "pnpm exec vite --config vite.phase7.config.ts --host 127.0.0.1 --port 4193",
    url: "http://127.0.0.1:4193/phase7-explorer/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
