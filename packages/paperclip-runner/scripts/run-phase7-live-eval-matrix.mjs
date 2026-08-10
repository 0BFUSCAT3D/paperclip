import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const suite = await import(resolve(packageRoot, "dist/conformance/phase7-eval-suite.js"));
const matrix = await suite.runPhase7LiveCodexMatrix(process.cwd());
const report = {
  schema: "paperclip.phase7.live-codex-matrix.v1",
  groups: matrix.length,
  matrix,
};
const output = resolve(packageRoot, "knowledge/evidence/phase-07/live-codex-matrix.json");
const markdown = output.replace(/\.json$/, ".md");
await mkdir(dirname(output), { recursive: true });
await Promise.all([
  writeFile(output, `${JSON.stringify(report, null, 2)}\n`),
  writeFile(markdown, [
    "# Phase 7 Live Codex Matrix",
    "",
    `- Groups: ${report.groups}`,
    `- Cases: ${matrix.map((entry) => `${entry.group}:${entry.caseId}`).join(", ")}`,
    "- Each row asserts expected and observed typed calls plus final mock state.",
    "",
  ].join("\n")),
]);
process.stdout.write(`Phase 7 live Codex matrix passed: ${matrix.length} groups.\n`);
process.stdout.write(`Live matrix reports: ${output} and ${markdown}\n`);
