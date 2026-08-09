import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@paperclipai/paperclip-runner/react", replacement: resolve(packageRoot, "src/react/index.ts") },
      { find: "@paperclip-runner-local/phase7", replacement: resolve(packageRoot, "src/phase7/index.ts") },
    ],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "devtools/browser/src/**/*.test.ts",
      "examples/phase7-explorer/src/**/*.test.ts",
      "examples/phase7-explorer/src/**/*.test.tsx",
      "scripts/phase2-browser-server.test.mjs",
      "scripts/phase4b-browser-server.test.mjs",
    ],
  },
});
