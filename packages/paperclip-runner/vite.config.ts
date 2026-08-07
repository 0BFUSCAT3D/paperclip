import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(packageRoot, "devtools/browser"),
  plugins: [react()],
  build: {
    outDir: resolve(packageRoot, "dist-browser"),
    emptyOutDir: true,
    // The standalone devtool targets current evergreen browsers. Keeping the
    // emitted syntax modern also avoids asking Vite to downlevel Ajv's runtime
    // validator, which recent esbuild releases intentionally do not support.
    target: "esnext",
  },
});
