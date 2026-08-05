import { readFile } from "node:fs/promises";

// The reviewed portable Claude quota probe source. A sandbox quota run stages
// these exact bytes into the sandbox and runs them through the exec seam. The
// bytes come from the adjacent `quota-probe.sh` file, so the staged script
// matches the reviewed file byte for byte. The module reads the file one time
// and caches the read.
let cachedSource: Promise<string> | null = null;

export function getClaudeQuotaProbeSource(): Promise<string> {
  if (!cachedSource) {
    cachedSource = readFile(new URL("./quota-probe.sh", import.meta.url), "utf8");
  }
  return cachedSource;
}
