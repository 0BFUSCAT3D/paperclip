#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot =
  process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
  process.env.PAPERCLIP_SCRATCH_DIR ??
  tmpdir();
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(join(scratchRoot, "paperclip-runner-phase4-"));
const rawTracePath = join(workspace, "trace.raw.json");
const evidencePath = join(
  packageRoot,
  "knowledge/evidence/phase-04-codex-trace.json",
);

try {
  const run = spawnSync(
    process.execPath,
    [
      join(packageRoot, "dist/cli/phase4-codex.js"),
      "--working-directory",
      workspace,
      "--output",
      rawTracePath,
    ],
    { cwd: packageRoot, env: process.env, stdio: "inherit" },
  );
  if (run.status !== 0) {
    throw new Error(`Phase 4 tracer exited with status ${run.status ?? "unknown"}`);
  }

  const trace = JSON.parse(await readFile(rawTracePath, "utf8"));
  if (Object.values(trace.assertions ?? {}).some((passed) => passed !== true)) {
    throw new Error("Phase 4 tracer reported a failed assertion");
  }
  const hello = await readFile(join(workspace, "hello.txt"), "utf8");
  if (hello !== "hello from phase 4") {
    throw new Error("Phase 4 safe task produced unexpected hello.txt content");
  }

  const replacements = [[workspace, "$PHASE4_WORKSPACE"]];
  const writableRoots = trace.context?.sandbox?.writableRoots;
  if (Array.isArray(writableRoots)) {
    writableRoots.forEach((root, index) => {
      if (typeof root === "string" && root.length > 0) {
        replacements.push([root, `$CODEX_WRITABLE_ROOT_${index + 1}`]);
      }
    });
  }
  const normalized = normalizeStrings(trace, replacements);
  await writeFile(evidencePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  process.stdout.write(`Recorded ${evidencePath}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function normalizeStrings(value, replacements) {
  if (typeof value === "string") {
    return replacements.reduce(
      (current, [from, to]) => current.replaceAll(from, to),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStrings(entry, replacements));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeStrings(entry, replacements),
      ]),
    );
  }
  return value;
}
