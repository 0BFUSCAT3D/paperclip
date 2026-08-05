#!/usr/bin/env node
//
// Quota parity check.
//
// The check proves the portable shell probe returns the same five windows as
// the host function `fetchClaudeQuota`. It compares each window on three fields:
//  - label: equal.
//  - usedPercent: within one point.
//  - resetsAt: equal.
//
// Two modes:
//  - live:    a token is available (environment or credential file). The check
//             calls the real Anthropic usage endpoint through both paths and
//             compares the two results for the same account.
//  - fixture: no token is available. The check reads one recorded OAuth usage
//             response. It runs the host mapping with a stubbed fetch and runs
//             the shell probe with `--map-stdin`. Both read the same response,
//             so the check proves the two mappings agree.
//
// Run: pnpm exec tsx src/cli/quota-parity.ts

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QuotaWindow } from "@paperclipai/adapter-utils";
import { fetchClaudeQuota, readClaudeToken } from "../server/quota.js";

const SCRIPT_PATH = fileURLToPath(new URL("./quota-probe.sh", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/oauth-usage.json", import.meta.url));

interface ProbeEnvelope {
  aggregated?: { windows?: QuotaWindow[] };
}

function runProbeMapStdin(oauthResponse: string): QuotaWindow[] {
  const stdout = execFileSync("bash", [SCRIPT_PATH, "--map-stdin"], {
    input: oauthResponse,
    encoding: "utf8",
  });
  const envelope = JSON.parse(stdout) as ProbeEnvelope;
  return envelope.aggregated?.windows ?? [];
}

function runProbeLive(): QuotaWindow[] {
  const stdout = execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8" });
  const envelope = JSON.parse(stdout) as ProbeEnvelope;
  return envelope.aggregated?.windows ?? [];
}

async function hostWindowsFromFixture(oauthResponse: string): Promise<QuotaWindow[]> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(oauthResponse, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await fetchClaudeQuota("fixture-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

interface WindowDiff {
  label: string;
  labelEqual: boolean;
  usedPercentHost: number | null;
  usedPercentProbe: number | null;
  usedPercentWithinOne: boolean;
  resetsAtEqual: boolean;
  ok: boolean;
}

function within(hostValue: number | null, probeValue: number | null, tolerance: number): boolean {
  if (hostValue === null && probeValue === null) return true;
  if (hostValue === null || probeValue === null) return false;
  return Math.abs(hostValue - probeValue) <= tolerance;
}

function compare(host: QuotaWindow[], probe: QuotaWindow[]): WindowDiff[] {
  const count = Math.max(host.length, probe.length);
  const diffs: WindowDiff[] = [];
  for (let index = 0; index < count; index += 1) {
    const hostWindow = host[index];
    const probeWindow = probe[index];
    const labelEqual = hostWindow?.label === probeWindow?.label;
    const usedPercentHost = hostWindow?.usedPercent ?? null;
    const usedPercentProbe = probeWindow?.usedPercent ?? null;
    const usedPercentWithinOne = within(usedPercentHost, usedPercentProbe, 1);
    const resetsAtEqual = (hostWindow?.resetsAt ?? null) === (probeWindow?.resetsAt ?? null);
    diffs.push({
      label: hostWindow?.label ?? probeWindow?.label ?? "(missing)",
      labelEqual,
      usedPercentHost,
      usedPercentProbe,
      usedPercentWithinOne,
      resetsAtEqual,
      ok: labelEqual && usedPercentWithinOne && resetsAtEqual,
    });
  }
  return diffs;
}

async function main(): Promise<void> {
  const token = await readClaudeToken();
  const live = token !== null;

  let hostWindows: QuotaWindow[];
  let probeWindows: QuotaWindow[];

  if (live && token) {
    console.log("mode: live (a local Claude token is available)");
    hostWindows = await fetchClaudeQuota(token);
    probeWindows = runProbeLive();
  } else {
    console.log("mode: fixture (no local Claude token; both paths read one recorded response)");
    const oauthResponse = readFileSync(FIXTURE_PATH, "utf8");
    hostWindows = await hostWindowsFromFixture(oauthResponse);
    probeWindows = runProbeMapStdin(oauthResponse);
  }

  const diffs = compare(hostWindows, probeWindows);
  const countEqual = hostWindows.length === probeWindows.length;

  console.log(`host windows: ${hostWindows.length}`);
  console.log(`probe windows: ${probeWindows.length}`);
  console.log("");
  for (const diff of diffs) {
    const verdict = diff.ok ? "PASS" : "FAIL";
    console.log(
      `[${verdict}] ${diff.label} | label=${diff.labelEqual} ` +
        `usedPercent host=${diff.usedPercentHost} probe=${diff.usedPercentProbe} within1=${diff.usedPercentWithinOne} ` +
        `resetsAt=${diff.resetsAtEqual}`,
    );
  }

  const allWindowsOk = diffs.every((diff) => diff.ok);
  const pass = countEqual && allWindowsOk;
  console.log("");
  console.log(`window-count-equal: ${countEqual}`);
  console.log(`parity: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}

await main();
