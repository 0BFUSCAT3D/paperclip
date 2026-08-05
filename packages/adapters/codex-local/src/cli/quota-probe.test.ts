import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSandboxQuotaEnvelope } from "@paperclipai/adapter-utils/quota-envelope";

/**
 * Contract test for the portable Codex quota probe shell script.
 *
 * The script reads a fixed WHAM usage response and prints the quota envelope
 * that the host parser accepts. The test never calls the network. It drives the
 * mapping through the `--map-stdin` mode and drives the missing-token guard
 * through the default mode with an empty CODEX_HOME directory.
 */

const SCRIPT_PATH = fileURLToPath(new URL("./quota-probe.sh", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/wham-usage.json", import.meta.url));

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

describe("portable Codex quota probe", () => {
  it("maps a fixed WHAM response to the two windows and the credits", () => {
    const whamResponse = readFileSync(FIXTURE_PATH, "utf8");
    const stdout = runProbe(["--map-stdin"], { input: whamResponse });

    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.tokenAvailable).toBe(true);
    expect(envelope.aggregated.provider).toBe("openai");
    expect(envelope.aggregated.source).toBe("codex-wham");
    expect(envelope.aggregated.windows).toEqual([
      {
        label: "5h limit",
        usedPercent: 23,
        resetsAt: "2026-08-05T18:30:00.000Z",
        valueLabel: null,
        detail: null,
      },
      {
        label: "Weekly limit",
        usedPercent: 61,
        resetsAt: "2026-08-11T00:00:00.000Z",
        valueLabel: null,
        detail: null,
      },
      {
        label: "Credits",
        usedPercent: null,
        resetsAt: null,
        valueLabel: "$4.20 remaining",
        detail: null,
      },
    ]);

    // The host parser must accept the probe output as-is.
    const parsed = parseSandboxQuotaEnvelope(stdout, "openai");
    expect(parsed.ok).toBe(true);
    expect(parsed.windows).toHaveLength(3);
    expect(parsed.source).toBe("codex-wham");
  });

  it("reads a 0-1 fraction used_percent the same way the host does", () => {
    const stdout = runProbe(["--map-stdin"], {
      input: JSON.stringify({
        rate_limit: { primary_window: { used_percent: 0.23, reset_at: null } },
      }),
    });
    const envelope = JSON.parse(stdout);
    expect(envelope.aggregated.windows).toEqual([
      {
        label: "5h limit",
        usedPercent: 23,
        resetsAt: null,
        valueLabel: null,
        detail: null,
      },
    ]);
  });

  it("omits the Credits window when credits are unlimited", () => {
    const stdout = runProbe(["--map-stdin"], {
      input: JSON.stringify({
        rate_limit: { primary_window: { used_percent: 10, reset_at: null } },
        credits: { unlimited: true, balance: 999 },
      }),
    });
    const envelope = JSON.parse(stdout);
    expect(envelope.aggregated.windows).toEqual([
      {
        label: "5h limit",
        usedPercent: 10,
        resetsAt: null,
        valueLabel: null,
        detail: null,
      },
    ]);
  });

  it("labels credits as N/A when the balance is absent", () => {
    const stdout = runProbe(["--map-stdin"], {
      input: JSON.stringify({ credits: { unlimited: false } }),
    });
    const envelope = JSON.parse(stdout);
    expect(envelope.aggregated.windows).toEqual([
      {
        label: "Credits",
        usedPercent: null,
        resetsAt: null,
        valueLabel: "N/A",
        detail: null,
      },
    ]);
  });

  it("prints ok:false and no token text when no token is available", () => {
    const emptyCodexHome = mkdtempSync(path.join(tmpdir(), "codex-probe-noauth-"));
    tempDirs.push(emptyCodexHome);

    let stdout = "";
    let threw = false;
    try {
      stdout = runProbe([], { env: { CODEX_HOME: emptyCodexHome } });
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
  });
});

/**
 * Static assertions on the probe source for the two security conditions.
 *
 * These assertions let a later security review confirm the hardening without a
 * live network call. They read the script text and check the curl target
 * hardening (C6) and the token-out-of-argv rule (C7).
 */
describe("Codex quota probe security conditions", () => {
  const script = readFileSync(fileURLToPath(new URL("./quota-probe.sh", import.meta.url)), "utf8");

  it("C6: calls only the one allowlisted WHAM url and hardens the curl target", () => {
    // The only https url literal is the WHAM usage endpoint.
    const urls = script.match(/https?:\/\/[^\s"']+/g) ?? [];
    expect(urls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);

    expect(script).toContain("--disable");
    expect(script).toContain("--max-redirs 0");
    expect(script).toContain("--noproxy '*'");
    expect(script).toContain("--connect-timeout");
    expect(script).toContain("--max-time");
    expect(script).toContain("--max-filesize");
    expect(script).toContain("head -c");
    // The probe never follows redirects.
    expect(script).not.toMatch(/(^|\s)-L(\s|$)/m);
    expect(script).not.toContain("--location");
    // The probe never turns TLS verification off.
    expect(script).not.toContain("--insecure");
    expect(script).not.toMatch(/(^|\s)-k(\s|$)/m);
  });

  it("C7: keeps the token out of argv and reads the header from a curl config on stdin", () => {
    // The Authorization header goes through a curl config on standard input.
    expect(script).toContain("--config -");
    // The token never appears as a curl --header/-H argument.
    expect(script).not.toMatch(/--header\s+["']?Authorization/);
    expect(script).not.toMatch(/-H\s+["']?Authorization/);
    // Shell trace stays off, so the token never reaches the trace stream.
    expect(script).toContain("set +x");
    // A trap removes the temporary response file, and that file holds only the
    // response body, never the token.
    expect(script).toContain("trap cleanup");
    expect(script).toContain('rm -f "${BODY_FILE}"');
  });
});
