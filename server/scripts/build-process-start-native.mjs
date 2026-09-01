import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.stdout.write("[server] skipping Darwin proc_pidinfo addon build\n");
  process.exit(0);
}

const required = process.env.PAPERCLIP_NATIVE_BUILD_REQUIRED === "1";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(packageRoot, "dist");
const source = join(packageRoot, "native", "process-start-native.c");
const output = join(outputDir, "process-start-native.node");
const temporaryOutput = `${output}.building`;
const nodePrefix = process.config.variables.node_prefix;
const headerCandidates = [
  typeof nodePrefix === "string" ? join(nodePrefix, "include", "node") : "",
  resolve(dirname(process.execPath), "..", "include", "node"),
  "/usr/local/include/node",
  "/opt/homebrew/include/node",
].filter(Boolean);
const headerDir = headerCandidates.find((candidate) => existsSync(join(candidate, "node_api.h")));

function unavailable(message) {
  if (required) throw new Error(message);
  process.stderr.write(`[server] ${message}; exact Darwin process identity will remain unavailable\n`);
  process.exit(0);
}

if (!headerDir) unavailable("cannot build proc_pidinfo addon because Node.js headers were not found");
if (!existsSync("/usr/bin/cc") || !existsSync("/usr/bin/xcrun") || !existsSync("/usr/bin/lipo")) {
  unavailable("cannot build proc_pidinfo addon because Apple Command Line Tools are unavailable");
}

const commandEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
  ZERO_AR_DATE: "1",
};
const sdk = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
  encoding: "utf8",
  env: commandEnv,
});
if (sdk.status !== 0 || !sdk.stdout.trim()) unavailable("cannot resolve the macOS SDK for proc_pidinfo addon");

mkdirSync(outputDir, { recursive: true });
rmSync(temporaryOutput, { force: true });
const result = spawnSync(
  "/usr/bin/cc",
  [
    "-std=c11",
    "-Os",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-bundle",
    "-undefined", "dynamic_lookup",
    "-mmacosx-version-min=12.0",
    "-arch", "arm64",
    "-arch", "x86_64",
    "-isysroot", sdk.stdout.trim(),
    `-I${headerDir}`,
    source,
    "-o", temporaryOutput,
  ],
  { encoding: "utf8", env: commandEnv },
);
if (result.error || result.status !== 0) {
  rmSync(temporaryOutput, { force: true });
  unavailable(
    `proc_pidinfo addon compiler failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
  );
}
const architectureCheck = spawnSync(
  "/usr/bin/lipo",
  [temporaryOutput, "-verify_arch", "arm64", "x86_64"],
  { encoding: "utf8", env: commandEnv },
);
if (architectureCheck.status !== 0) {
  rmSync(temporaryOutput, { force: true });
  unavailable("proc_pidinfo addon is not a universal arm64/x86_64 Mach-O bundle");
}
renameSync(temporaryOutput, output);
process.stdout.write(`[server] built universal Darwin proc_pidinfo addon at ${output}\n`);
