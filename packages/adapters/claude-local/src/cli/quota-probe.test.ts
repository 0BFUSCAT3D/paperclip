import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSandboxQuotaEnvelope } from "@paperclipai/adapter-utils/quota-envelope";

/**
 * Contract test for the portable Claude quota probe shell script.
 *
 * The script reads a fixed OAuth usage response and prints the quota envelope
 * that the host parser accepts. The test never calls the network. It drives the
 * mapping through the `--map-stdin` mode and drives the missing-token guard
 * through the default mode with an empty credential directory.
 */

const SCRIPT_PATH = fileURLToPath(new URL("./quota-probe.sh", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/oauth-usage.json", import.meta.url));

const CLEAN_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: "/nonexistent-home-for-probe-test",
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function runProbe(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  const stdout = execFileSync("bash", [SCRIPT_PATH, ...args], {
    input: options.input ?? "",
    env: { ...CLEAN_ENV, ...(options.env ?? {}) },
    encoding: "utf8",
  });
  return stdout;
}

describe("portable Claude quota probe", () => {
  it("maps a fixed OAuth response to the five host windows", () => {
    const oauthResponse = readFileSync(FIXTURE_PATH, "utf8");
    const stdout = runProbe(["--map-stdin"], { input: oauthResponse });

    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.tokenAvailable).toBe(true);
    expect(envelope.aggregated.provider).toBe("anthropic");
    expect(envelope.aggregated.source).toBe("anthropic-oauth");
    expect(envelope.aggregated.windows).toEqual([
      {
        label: "Current session",
        usedPercent: 37,
        resetsAt: "2026-08-05T18:00:00.000Z",
        valueLabel: null,
        detail: null,
      },
      {
        label: "Current week (all models)",
        usedPercent: 52,
        resetsAt: "2026-08-11T00:00:00.000Z",
        valueLabel: null,
        detail: null,
      },
      {
        label: "Current week (Sonnet only)",
        usedPercent: 44,
        resetsAt: "2026-08-11T00:00:00.000Z",
        valueLabel: null,
        detail: null,
      },
      {
        label: "Current week (Opus only)",
        usedPercent: 12,
        resetsAt: "2026-08-11T00:00:00.000Z",
        valueLabel: null,
        detail: null,
      },
      {
        label: "Extra usage",
        usedPercent: 8,
        resetsAt: null,
        valueLabel: "$12.00 / $50.00",
        detail: "Monthly extra usage pool",
      },
    ]);

    // The host parser must accept the probe output as-is.
    const parsed = parseSandboxQuotaEnvelope(stdout, "anthropic");
    expect(parsed.ok).toBe(true);
    expect(parsed.windows).toHaveLength(5);
    expect(parsed.source).toBe("anthropic-oauth");
  });

  it("reads a 0-1 fraction utilization the same way the host does", () => {
    const stdout = runProbe(["--map-stdin"], {
      input: JSON.stringify({ five_hour: { utilization: 0.37, resets_at: null } }),
    });
    const envelope = JSON.parse(stdout);
    expect(envelope.aggregated.windows).toEqual([
      {
        label: "Current session",
        usedPercent: 37,
        resetsAt: null,
        valueLabel: null,
        detail: null,
      },
    ]);
  });

  it("marks a disabled extra-usage pool as not enabled", () => {
    const stdout = runProbe(["--map-stdin"], {
      input: JSON.stringify({ extra_usage: { is_enabled: false, utilization: 40 } }),
    });
    const envelope = JSON.parse(stdout);
    expect(envelope.aggregated.windows).toEqual([
      {
        label: "Extra usage",
        usedPercent: null,
        resetsAt: null,
        valueLabel: "Not enabled",
        detail: "Extra usage not enabled",
      },
    ]);
  });

  it("maps rate-limit headers to the three unified windows", () => {
    const headers = [
      "HTTP/2 200",
      "anthropic-ratelimit-unified-5h-utilization: 0.12",
      "anthropic-ratelimit-unified-5h-reset: 1754424600",
      "anthropic-ratelimit-unified-7d-utilization: 31",
      "anthropic-ratelimit-unified-7d-reset: 1754661600",
      "anthropic-ratelimit-unified-7d_sonnet-utilization: 0.05",
      "anthropic-ratelimit-unified-7d_sonnet-reset: 1754661600",
      "",
    ].join("\r\n");
    const stdout = runProbe(["--map-headers-stdin"], { input: headers });
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.aggregated.source).toBe("anthropic-oauth");
    expect(envelope.aggregated.windows).toEqual([
      { label: "Current session", usedPercent: 12, resetsAt: "2025-08-05T20:10:00Z", valueLabel: null, detail: null },
      { label: "Current week (all models)", usedPercent: 31, resetsAt: "2025-08-08T14:00:00Z", valueLabel: null, detail: null },
      { label: "Current week (Sonnet only)", usedPercent: 5, resetsAt: "2025-08-08T14:00:00Z", valueLabel: null, detail: null },
    ]);
    // The host parser must accept the fallback output as-is.
    const parsed = parseSandboxQuotaEnvelope(stdout, "anthropic");
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe("anthropic-oauth");
  });

  it("drops a header window with a bad utilization or an out-of-range reset", () => {
    const headers = [
      "anthropic-ratelimit-unified-5h-utilization: not-a-number",
      "anthropic-ratelimit-unified-5h-reset: 999",
      "anthropic-ratelimit-unified-7d-utilization: 42",
      "anthropic-ratelimit-unified-7d-reset: 1754661600",
      "",
    ].join("\r\n");
    const stdout = runProbe(["--map-headers-stdin"], { input: headers });
    const envelope = JSON.parse(stdout);
    expect(envelope.aggregated.windows).toEqual([
      { label: "Current week (all models)", usedPercent: 42, resetsAt: "2025-08-08T14:00:00Z", valueLabel: null, detail: null },
    ]);
  });

  it("prints ok:false and no token text when no token is available", () => {
    const emptyConfigDir = mkdtempSync(path.join(tmpdir(), "claude-probe-noauth-"));
    tempDirs.push(emptyConfigDir);

    let stdout = "";
    let threw = false;
    try {
      stdout = runProbe([], { env: { CLAUDE_CONFIG_DIR: emptyConfigDir } });
    } catch (error) {
      // The probe exits non-zero on failure; capture its stdout for assertions.
      threw = true;
      const execError = error as { stdout?: string | Buffer };
      stdout = execError.stdout ? execError.stdout.toString() : "";
    }

    expect(threw).toBe(true);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.tokenAvailable).toBe(false);
    expect(envelope.aggregated.ok).toBe(false);
    expect(envelope.aggregated.windows).toEqual([]);
    expect(typeof envelope.aggregated.error).toBe("string");
    // No credential material may appear anywhere in the output.
    expect(stdout).not.toContain("Bearer");
    expect(stdout).not.toContain("sk-ant");
  });
});

/**
 * Control-flow contract tests for the header fallback.
 *
 * These tests replace `curl` with a shim on the PATH. The shim records which
 * endpoint the probe requested and returns a canned status, body, and headers.
 * The tests never call the network. They prove that the probe reaches the
 * messages fallback only after the usage endpoint returns 401 or 403, that it
 * makes one fallback call, and that the token never appears in the output.
 */

const FAKE_TOKEN = "sk-ant-oat01-FAKESENTINEL-do-not-print";

// A minimal fake `curl`. It reads the requested URL from the last argument,
// records the endpoint to a log file, and writes the canned body and headers.
const FAKE_CURL = `#!/usr/bin/env bash
set -u
log="\${FAKE_CURL_LOG:-/dev/null}"
dumpfile=""
outfile=""
url=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --dump-header) dumpfile="$arg" ;;
    --output) outfile="$arg" ;;
  esac
  url="$arg"
  prev="$arg"
done
# Consume the token config on standard input and never echo it.
cat >/dev/null 2>&1 || true
case "$url" in
  *"/api/oauth/usage")
    printf 'usage\\n' >>"$log"
    [ -n "$outfile" ] && printf '%s' "\${FAKE_USAGE_BODY:-}" >"$outfile"
    printf '%s' "\${FAKE_USAGE_CODE:-200}"
    exit 0
    ;;
  *"/v1/messages")
    printf 'messages\\n' >>"$log"
    [ -n "$dumpfile" ] && printf '%s' "\${FAKE_MESSAGES_HEADERS:-}" >"$dumpfile"
    [ -n "$outfile" ] && : >"$outfile"
    printf '%s' "\${FAKE_MESSAGES_CODE:-200}"
    exit 0
    ;;
esac
printf '000'
exit 1
`;

interface FallbackRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
}

function runProbeWithFakeCurl(env: Record<string, string>): FallbackRunResult {
  const shimDir = mkdtempSync(path.join(tmpdir(), "claude-probe-shim-"));
  tempDirs.push(shimDir);
  const curlPath = path.join(shimDir, "curl");
  writeFileSync(curlPath, FAKE_CURL, { mode: 0o755 });
  chmodSync(curlPath, 0o755);
  const logPath = path.join(shimDir, "calls.log");

  const result = spawnSync("bash", [SCRIPT_PATH], {
    input: "",
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      HOME: "/nonexistent-home-for-probe-test",
      FAKE_CURL_LOG: logPath,
      CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
      ...env,
    },
    encoding: "utf8",
  });

  let calls: string[] = [];
  try {
    calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    calls = [];
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", calls };
}

const OAUTH_USAGE_BODY = JSON.stringify({
  five_hour: { utilization: 0.2, resets_at: "2026-08-05T20:00:00Z" },
  seven_day: { utilization: 0.3, resets_at: "2026-08-11T00:00:00Z" },
});

const FALLBACK_HEADERS = [
  "HTTP/2 200",
  "anthropic-ratelimit-unified-5h-utilization: 0.12",
  "anthropic-ratelimit-unified-5h-reset: 1754424600",
  "anthropic-ratelimit-unified-7d-utilization: 31",
  "anthropic-ratelimit-unified-7d-reset: 1754661600",
  "",
].join("\r\n");

describe("portable Claude quota probe — header fallback", () => {
  it("does not call the messages endpoint when the usage endpoint returns 2xx", () => {
    const run = runProbeWithFakeCurl({ FAKE_USAGE_CODE: "200", FAKE_USAGE_BODY: OAUTH_USAGE_BODY });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(["usage"]);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.aggregated.windows).toHaveLength(2);
  });

  it("calls the messages endpoint exactly once after a 401 and maps the headers", () => {
    const run = runProbeWithFakeCurl({
      FAKE_USAGE_CODE: "401",
      FAKE_MESSAGES_CODE: "200",
      FAKE_MESSAGES_HEADERS: FALLBACK_HEADERS,
    });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(["usage", "messages"]);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.aggregated.windows).toEqual([
      { label: "Current session", usedPercent: 12, resetsAt: "2025-08-05T20:10:00Z", valueLabel: null, detail: null },
      { label: "Current week (all models)", usedPercent: 31, resetsAt: "2025-08-08T14:00:00Z", valueLabel: null, detail: null },
    ]);
    // The token must never appear in the output.
    expect(run.stdout).not.toContain(FAKE_TOKEN);
    expect(run.stderr).not.toContain(FAKE_TOKEN);
    expect(run.stdout).not.toContain("Bearer");
  });

  it("falls back after a 403 as well", () => {
    const run = runProbeWithFakeCurl({
      FAKE_USAGE_CODE: "403",
      FAKE_MESSAGES_CODE: "200",
      FAKE_MESSAGES_HEADERS: FALLBACK_HEADERS,
    });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(["usage", "messages"]);
  });

  it("does not fall back when the usage endpoint returns 429", () => {
    const run = runProbeWithFakeCurl({ FAKE_USAGE_CODE: "429" });
    expect(run.status).not.toBe(0);
    expect(run.calls).toEqual(["usage"]);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.aggregated.errorFamily).toBe("provider_quota");
  });

  it("does not fall back when the usage endpoint returns 500", () => {
    const run = runProbeWithFakeCurl({ FAKE_USAGE_CODE: "500" });
    expect(run.status).not.toBe(0);
    expect(run.calls).toEqual(["usage"]);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(false);
  });

  it("fails closed when the fallback returns no usable headers", () => {
    const run = runProbeWithFakeCurl({
      FAKE_USAGE_CODE: "401",
      FAKE_MESSAGES_CODE: "200",
      FAKE_MESSAGES_HEADERS: "HTTP/2 400\r\nx-nothing: 1\r\n",
    });
    expect(run.status).not.toBe(0);
    expect(run.calls).toEqual(["usage", "messages"]);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.aggregated.windows).toEqual([]);
  });
});
