import { describe, expect, it } from "vitest";
import { MAX_QUOTA_ENVELOPE_CHARS, parseSandboxQuotaEnvelope } from "./quota-envelope.js";

describe("parseSandboxQuotaEnvelope", () => {
  it("parses a top-level ProviderQuotaResult and keeps only allowed fields", () => {
    const envelope = JSON.stringify({
      provider: "anthropic",
      source: "claude-cli",
      ok: true,
      windows: [
        { label: "5h", usedPercent: 12, resetsAt: null, valueLabel: null, detail: null },
      ],
      unexpected: "drop me",
    });

    const result = parseSandboxQuotaEnvelope(envelope, "anthropic");

    expect(result).toEqual({
      provider: "anthropic",
      source: "claude-cli",
      ok: true,
      windows: [{ label: "5h", usedPercent: 12, resetsAt: null, valueLabel: null, detail: null }],
    });
  });

  it("reads the ProviderQuotaResult from the `aggregated` field when present", () => {
    const envelope = JSON.stringify({
      ok: true,
      timestamp: "2026-08-04T00:00:00.000Z",
      aggregated: {
        provider: "openai",
        ok: true,
        windows: [{ label: "Weekly limit", usedPercent: 50, resetsAt: null, valueLabel: null }],
      },
    });

    const result = parseSandboxQuotaEnvelope(envelope, "openai");

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.windows).toEqual([
      { label: "Weekly limit", usedPercent: 50, resetsAt: null, valueLabel: null, detail: null },
    ]);
  });

  it("forces the provider slug to the expected value", () => {
    const envelope = JSON.stringify({ provider: "evil", ok: true, windows: [] });

    const result = parseSandboxQuotaEnvelope(envelope, "anthropic");

    expect(result.provider).toBe("anthropic");
  });

  it("keeps only a known error family and drops an unknown one", () => {
    const known = parseSandboxQuotaEnvelope(
      JSON.stringify({ provider: "openai", ok: false, error: "x", errorFamily: "provider_quota", windows: [] }),
      "openai",
    );
    expect(known.errorFamily).toBe("provider_quota");

    const unknown = parseSandboxQuotaEnvelope(
      JSON.stringify({ provider: "openai", ok: false, error: "x", errorFamily: "made_up_family", windows: [] }),
      "openai",
    );
    expect(unknown.errorFamily).toBeUndefined();
  });

  it("clamps usedPercent into 0-100 and coerces non-numbers to null", () => {
    const envelope = JSON.stringify({
      provider: "anthropic",
      ok: true,
      windows: [
        { label: "over", usedPercent: 250 },
        { label: "under", usedPercent: -5 },
        { label: "bad", usedPercent: "80" },
      ],
    });

    const result = parseSandboxQuotaEnvelope(envelope, "anthropic");

    expect(result.windows.map((w) => w.usedPercent)).toEqual([100, 0, null]);
  });

  it("fails closed on invalid JSON without echoing the raw output", () => {
    const result = parseSandboxQuotaEnvelope("secret=sk-abc\nnot json", "anthropic");

    expect(result).toEqual({
      provider: "anthropic",
      ok: false,
      error: "Quota probe output was not valid JSON.",
      windows: [],
    });
    expect(JSON.stringify(result)).not.toContain("sk-abc");
  });

  it("fails closed when the output exceeds the size cap", () => {
    const huge = `{"filler":"${"a".repeat(MAX_QUOTA_ENVELOPE_CHARS)}"}`;

    const result = parseSandboxQuotaEnvelope(huge, "openai");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Quota probe output exceeded the size limit.");
    expect(result.windows).toEqual([]);
  });

  it("fails closed on empty output", () => {
    const result = parseSandboxQuotaEnvelope("   ", "openai");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Quota probe returned no output.");
  });
});
