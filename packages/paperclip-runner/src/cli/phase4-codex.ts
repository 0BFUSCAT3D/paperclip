#!/usr/bin/env node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createPhase4TaskEnvelope } from "../contracts/phase4.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import { runPhase4CodexTracer } from "../mock-core/phase4-codex-runner.js";

interface CliOptions {
  workingDirectory?: string;
  output?: string;
  steer?: string;
  interrupt: boolean;
  json: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { interrupt: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") continue;
    if (value === "--json") options.json = true;
    else if (value === "--interrupt") options.interrupt = true;
    else if (value === "--working-directory") options.workingDirectory = args[++index];
    else if (value === "--output") options.output = args[++index];
    else if (value === "--steer") options.steer = args[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function formatSummary(trace: Awaited<ReturnType<typeof runPhase4CodexTracer>>): string {
  const checks = Object.entries(trace.assertions)
    .map(([name, passed]) => `${passed ? "PASS" : "FAIL"} ${name}`)
    .join("\n");
  return [
    "Phase 4 skillless Codex tracer",
    `driver session: ${trace.metadata.identity.driverSessionId}`,
    `provider session: ${trace.metadata.identity.providerSessionId}`,
    `model: ${trace.context.model} (${trace.context.modelProvider})`,
    `events: ${trace.events.length}`,
    trace.result === null
      ? `result: rejected — ${trace.resultDecision.issues.map((issue) => issue.message).join("; ")}`
      : `result: ${trace.result.reportedWorkDisposition} — ${trace.result.summary}`,
    checks,
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workingDirectory = options.workingDirectory
    ? resolve(options.workingDirectory)
    : await mkdtemp(join(tmpdir(), "paperclip-phase4-safe-"));
  await mkdir(workingDirectory, { recursive: true });
  const envelope = createPhase4TaskEnvelope({
    objective: "Create hello.txt in the working directory with exactly: hello from phase 4",
    criteria: [
      { id: "file-created", requirement: "hello.txt exists in the supplied working directory." },
      { id: "exact-content", requirement: "hello.txt contains exactly 'hello from phase 4'." },
    ],
    constraints: [
      "Write only hello.txt inside the supplied working directory.",
      "Do not use network access.",
      "Do not discover or invoke skills.",
      "Do not call a control-plane API.",
      "Return one semantic completion result.",
      ...(options.steer !== undefined || options.interrupt
        ? ["Before changing files, run the shell command 'sleep 3' once so the operator can send a control command."]
        : []),
    ],
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: envelope,
    onDiagnostic: (message) => process.stderr.write(`[codex app-server] ${message}\n`),
  });
  const trace = await runPhase4CodexTracer({
    driver,
    taskEnvelope: envelope,
    workingDirectory,
    steer: options.steer,
    interrupt: options.interrupt,
  });
  const serialized = `${JSON.stringify(trace, null, 2)}\n`;
  if (options.output) await writeFile(resolve(options.output), serialized, "utf8");
  process.stdout.write(options.json ? serialized : `${formatSummary(trace)}\nworkspace: ${workingDirectory}\n`);
  if (Object.values(trace.assertions).some((passed) => !passed)) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
