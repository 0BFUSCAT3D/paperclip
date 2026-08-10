import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { phase7IssueThreadServerPlugin } from "./scripts/phase7-issue-thread-server.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(packageRoot, "devtools/issue-thread"),
  plugins: [react(), phase7IssueThreadServerPlugin()],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
  build: {
    outDir: resolve(packageRoot, "dist-issue-thread"),
    emptyOutDir: true,
    target: "esnext",
  },
});
