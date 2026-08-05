import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
