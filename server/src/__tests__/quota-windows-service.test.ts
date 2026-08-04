import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import type { AdapterTestExecutionContext } from "../services/adapter-execution-context.js";

// A minimal sandbox target. The service only reads `kind`/`transport` to decide
// the untrusted-output sanitize pass; it passes the whole object to the adapter.
const SANDBOX_TARGET = {
  kind: "remote",
  transport: "sandbox",
  remoteCwd: "/work",
} as never;

interface RecordedLog {
  level: "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

function makeLogger() {
  const entries: RecordedLog[] = [];
  const record = (level: RecordedLog["level"]) => (obj: Record<string, unknown>, msg: string) => {
    entries.push({ level, obj, msg });
  };
  return {
    entries,
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

function makeContext(overrides: Partial<AdapterTestExecutionContext>): AdapterTestExecutionContext {
  return {
    executionTarget: null,
    environmentName: null,
    fallbackChecks: [],
    release: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("fetchAllQuotaWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns adapter results without waiting for a slower provider to finish forever", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      {
        type: "codex_local",
        getQuotaWindows: vi.fn().mockResolvedValue({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
        }),
      },
      {
        type: "claude_local",
        getQuotaWindows: vi.fn(() => new Promise(() => {})),
      },
    ] as never);

    const promise = fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(results).toEqual([
      {
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      },
      {
        provider: "anthropic",
        ok: false,
        error: "quota polling timed out after 20s",
        windows: [],
      },
    ]);
  });

  it("passes the resolved target to each adapter for a sandbox environment", async () => {
    const codexProbe = vi.fn().mockResolvedValue({ provider: "openai", ok: true, windows: [] });
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: codexProbe },
    ] as never);

    const release = vi.fn().mockResolvedValue(undefined);
    const resolveExecutionContext = vi.fn().mockResolvedValue(
      makeContext({ executionTarget: SANDBOX_TARGET, environmentName: "sbx", release }),
    );

    const results = await fetchAllQuotaWindows({
      environmentId: "env-1",
      companyId: "co-1",
      resolveExecutionContext,
      logger: makeLogger(),
    });

    expect(resolveExecutionContext).toHaveBeenCalledWith({
      companyId: "co-1",
      adapterType: "codex_local",
      environmentId: "env-1",
    });
    expect(codexProbe).toHaveBeenCalledWith({ executionTarget: SANDBOX_TARGET });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("released");
    expect(results[0]).toMatchObject({ provider: "openai", ok: true });
  });

  it("runs the host probe with no target when no environment is selected", async () => {
    const probe = vi.fn().mockResolvedValue({ provider: "openai", ok: true, windows: [] });
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: probe },
    ] as never);

    const resolveExecutionContext = vi.fn();
    const results = await fetchAllQuotaWindows({ resolveExecutionContext, logger: makeLogger() });

    expect(resolveExecutionContext).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledWith();
    expect(results[0]).toMatchObject({ ok: true });
  });

  it("runs the host probe for a local environment and still releases", async () => {
    const probe = vi.fn().mockResolvedValue({ provider: "openai", ok: true, windows: [] });
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: probe },
    ] as never);

    const release = vi.fn().mockResolvedValue(undefined);
    const resolveExecutionContext = vi.fn().mockResolvedValue(
      makeContext({ executionTarget: null, environmentName: "local", release }),
    );

    const results = await fetchAllQuotaWindows({
      environmentId: "env-local",
      companyId: "co-1",
      resolveExecutionContext,
      logger: makeLogger(),
    });

    expect(probe).toHaveBeenCalledWith({ executionTarget: null });
    expect(release).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ ok: true });
  });

  it("releases the lease when the probe throws", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("boom leaked-token-abc"));
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: probe },
    ] as never);

    const release = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const resolveExecutionContext = vi.fn().mockResolvedValue(
      makeContext({ executionTarget: SANDBOX_TARGET, environmentName: "sbx", release }),
    );

    const results = await fetchAllQuotaWindows({
      environmentId: "env-1",
      companyId: "co-1",
      resolveExecutionContext,
      logger,
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("failed");
    expect(results[0]).toMatchObject({ provider: "openai", ok: false });
    // The raw error text may carry probe stderr; the service must never log it.
    expect(JSON.stringify(logger.entries)).not.toContain("leaked-token-abc");
  });

  it("releases the lease after a post-acquire resolution failure and sets a failed result", async () => {
    const probe = vi.fn();
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: probe },
    ] as never);

    const release = vi.fn().mockResolvedValue(undefined);
    const resolveExecutionContext = vi.fn().mockResolvedValue(
      makeContext({
        executionTarget: null,
        environmentName: "sbx",
        fallbackChecks: [
          { code: "environment_target_failed", level: "error", message: "target failed" },
        ],
        release,
      }),
    );

    const results = await fetchAllQuotaWindows({
      environmentId: "env-1",
      companyId: "co-1",
      resolveExecutionContext,
      logger: makeLogger(),
    });

    expect(probe).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("failed");
    expect(results[0]).toMatchObject({ provider: "openai", ok: false });
  });

  it("sets a failed status and releases the lease when the probe times out", async () => {
    const probe = vi.fn(() => new Promise(() => {}));
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: probe },
    ] as never);

    const release = vi.fn().mockResolvedValue(undefined);
    const resolveExecutionContext = vi.fn().mockResolvedValue(
      makeContext({ executionTarget: SANDBOX_TARGET, environmentName: "sbx", release }),
    );

    const promise = fetchAllQuotaWindows({
      environmentId: "env-1",
      companyId: "co-1",
      resolveExecutionContext,
      logger: makeLogger(),
    });
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("failed");
    expect(results[0]).toMatchObject({ provider: "openai", ok: false });
    expect(results[0]!.error).toContain("timed out");
  });

  it("drops an extra credential-looking field from the probe result and never logs it", async () => {
    const probe = vi.fn().mockResolvedValue({
      provider: "openai",
      ok: true,
      windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      apiKey: "sk-secret-123",
      authToken: "tok-abc",
    });
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: probe },
    ] as never);

    const release = vi.fn().mockResolvedValue(undefined);
    const logger = makeLogger();
    const resolveExecutionContext = vi.fn().mockResolvedValue(
      makeContext({ executionTarget: SANDBOX_TARGET, environmentName: "sbx", release }),
    );

    const results = await fetchAllQuotaWindows({
      environmentId: "env-1",
      companyId: "co-1",
      resolveExecutionContext,
      logger,
    });

    const serializedResult = JSON.stringify(results);
    expect(serializedResult).not.toContain("sk-secret-123");
    expect(serializedResult).not.toContain("apiKey");
    expect(results[0]).not.toHaveProperty("apiKey");
    expect(results[0]).not.toHaveProperty("authToken");
    expect(results[0]!.windows).toHaveLength(1);

    const serializedLogs = JSON.stringify(logger.entries);
    expect(serializedLogs).not.toContain("sk-secret-123");
    expect(serializedLogs).not.toContain("apiKey");
  });

  it("does not let one slow sandbox adapter block the others", async () => {
    const fastProbe = vi.fn().mockResolvedValue({ provider: "openai", ok: true, windows: [] });
    const slowProbe = vi.fn(() => new Promise(() => {}));
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: fastProbe },
      { type: "claude_local", getQuotaWindows: slowProbe },
    ] as never);

    const fastRelease = vi.fn().mockResolvedValue(undefined);
    const slowRelease = vi.fn().mockResolvedValue(undefined);
    const resolveExecutionContext = vi
      .fn()
      .mockImplementation(async (input: { adapterType: string }) =>
        input.adapterType === "codex_local"
          ? makeContext({ executionTarget: SANDBOX_TARGET, environmentName: "sbx", release: fastRelease })
          : makeContext({ executionTarget: SANDBOX_TARGET, environmentName: "sbx", release: slowRelease }),
      );

    const promise = fetchAllQuotaWindows({
      environmentId: "env-1",
      companyId: "co-1",
      resolveExecutionContext,
      logger: makeLogger(),
    });
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(results[0]).toMatchObject({ provider: "openai", ok: true });
    expect(results[1]).toMatchObject({ provider: "anthropic", ok: false });
    expect(fastRelease).toHaveBeenCalledWith("released");
    expect(slowRelease).toHaveBeenCalledWith("failed");
  });
});
