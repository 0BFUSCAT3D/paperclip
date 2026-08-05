import { describe, expect, it } from "vitest";
import { parseSandboxQuotaEnvelope } from "./quota-envelope.js";
import type { ProviderQuotaResult } from "./types.js";

/**
 * Portable quota-probe contract.
 *
 * A quota probe runs inside an execution target (a sandbox or a remote host).
 * The probe prints one JSON envelope to stdout. The host reads that envelope
 * with `parseSandboxQuotaEnvelope`. This test fixes the contract between the two
 * sides: it proves the exact envelope shape that any probe must print, with one
 * canonical fixture per provider. The test does not run a probe, read a
 * credential, or call the network.
 *
 * Probe INPUT contract (the values a probe reads to build the envelope):
 *  1. Provider access token. The probe reads the token from an environment
 *     variable first. For the Claude provider the probe accepts
 *     `CLAUDE_CODE_OAUTH_TOKEN` first, then `CLAUDE_OAUTH_TOKEN`. For the Codex
 *     provider the probe accepts `CODEX_ACCESS_TOKEN`. If no token environment
 *     variable is set, the probe reads the token from the on-disk credential
 *     file of the provider. The environment variable always wins over the file.
 *  2. Provider selector. The host passes the expected provider slug to the
 *     parser as the second argument (`"anthropic"` for Claude, `"openai"` for
 *     Codex). The parser forces the `provider` field of the result to this slug,
 *     so a probe cannot report a different provider than the host expects.
 *
 * Probe OUTPUT contract (this test):
 *  - The probe prints a top-level JSON object. It wraps the aggregated
 *    `ProviderQuotaResult` in an `aggregated` field. The parser reads
 *    `aggregated` when it is an object, else it reads the top-level object.
 *  - The parser keeps only allowed fields. Each window keeps `label`,
 *    `usedPercent` (clamped to 0-100), `resetsAt`, `valueLabel`, and `detail`.
 *
 * A probe must satisfy this contract. Do not change `parseSandboxQuotaEnvelope`
 * to make a probe pass. Change the probe to match the parser.
 */
describe("portable quota-probe contract", () => {
  it("parses a canonical Claude envelope to the expected five windows", () => {
    const result = parseSandboxQuotaEnvelope(CANONICAL_CLAUDE_ENVELOPE, "anthropic");

    const expected: ProviderQuotaResult = {
      provider: "anthropic",
      source: "anthropic-oauth",
      ok: true,
      windows: [
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
      ],
    };

    expect(result).toEqual(expected);
    expect(result.windows).toHaveLength(5);
  });

  it("parses a canonical Codex envelope to the expected two windows and the credits", () => {
    const result = parseSandboxQuotaEnvelope(CANONICAL_CODEX_ENVELOPE, "openai");

    const expected: ProviderQuotaResult = {
      provider: "openai",
      source: "codex-wham",
      ok: true,
      windows: [
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
      ],
    };

    expect(result).toEqual(expected);
    expect(result.windows).toHaveLength(3);
  });
});

/**
 * Canonical Claude quota envelope.
 *
 * This is the stdout a Claude quota probe prints. The aggregated result carries
 * the five Claude windows: the current session, the all-models week, the
 * Sonnet-only week, the Opus-only week, and the extra-usage pool.
 */
const CANONICAL_CLAUDE_ENVELOPE = JSON.stringify({
  ok: true,
  timestamp: "2026-08-05T12:00:00.000Z",
  tokenAvailable: true,
  aggregated: {
    provider: "anthropic",
    source: "anthropic-oauth",
    ok: true,
    windows: [
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
    ],
  },
});

/**
 * Canonical Codex quota envelope.
 *
 * This is the stdout a Codex quota probe prints. The aggregated result carries
 * the two Codex rate-limit windows (the 5-hour limit and the weekly limit) and
 * the credits window.
 */
const CANONICAL_CODEX_ENVELOPE = JSON.stringify({
  ok: true,
  timestamp: "2026-08-05T12:00:00.000Z",
  tokenAvailable: true,
  aggregated: {
    provider: "openai",
    source: "codex-wham",
    ok: true,
    windows: [
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
    ],
  },
});
