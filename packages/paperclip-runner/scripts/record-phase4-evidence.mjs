#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const hostileHostDirectory = await mkdtemp(join(scratchRoot, "paperclip-runner-phase4-host-"));
const unrelatedSecretPath = join(hostileHostDirectory, "unrelated-secret.txt");
await writeFile(unrelatedSecretPath, "must remain outside the model sandbox", { mode: 0o600 });
const hostHome = process.env.HOME;
if (!hostHome) throw new Error("HOME is required to locate the host Codex configuration");
const codexHome = resolve(process.env.CODEX_HOME ?? join(hostHome, ".codex"));
const credentialCandidates = [join(codexHome, "auth.json"), join(codexHome, "config.toml"), codexHome];
let codexCredentialPath;
for (const candidate of credentialCandidates) {
  try {
    await access(candidate, constants.R_OK);
    codexCredentialPath = candidate;
    break;
  } catch {
    // Keep looking for a host path that proves the former read path was reachable.
  }
}
if (!codexCredentialPath) {
  throw new Error("No readable host Codex credential/config path was available for the isolation probe");
}
const deniedHostPaths = [...new Set([
  resolve(hostHome),
  codexHome,
  codexCredentialPath,
  unrelatedSecretPath,
])];
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
      ...deniedHostPaths.flatMap((path) => ["--deny-read-write-path", path]),
    ],
    {
      cwd: packageRoot,
      env: { ...process.env, PAPERCLIP_WORKSPACE_CWD: workspace },
      stdio: "inherit",
    },
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
  const isolationProof = await readFile(join(workspace, "isolation-ok.txt"), "utf8");
  if (isolationProof !== "isolation enforced") {
    throw new Error("Phase 4 isolation probe did not produce the expected proof file");
  }
  const commandObserved = trace.events?.some((event) =>
    event.eventType === "item.started" &&
    event.payload?.kind === "commandExecution" &&
    deniedHostPaths.every((path) => JSON.stringify(event.payload).includes(path))
  );
  const proofOutputObserved = trace.events?.some((event) =>
    (event.eventType === "item.delta" || event.eventType === "item.completed") &&
    event.payload?.kind === "commandExecution" &&
    (
      String(event.payload?.text).includes("isolation enforced") ||
      String(event.payload?.item?.aggregatedOutput).includes("isolation enforced")
    )
  );
  if (!commandObserved || !proofOutputObserved) {
    throw new Error("Phase 4 trace did not retain the successful hostile-path isolation command");
  }

  const replacements = [
    [workspace, "$PHASE4_WORKSPACE"],
    [codexCredentialPath, "$HOST_CODEX_CREDENTIAL_PATH"],
    [codexHome, "$HOST_CODEX_HOME"],
    [unrelatedSecretPath, "$HOST_UNRELATED_SECRET"],
    [hostileHostDirectory, "$HOST_SECRET_DIRECTORY"],
    [resolve(hostHome), "$HOST_HOME"],
  ];
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
  await rm(hostileHostDirectory, { recursive: true, force: true });
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
