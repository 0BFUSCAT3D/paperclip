import type {
  AdapterExecutionErrorFamily,
  ProviderQuotaResult,
  QuotaWindow,
} from "./types.js";

/**
 * Maximum number of characters the host reads from a sandbox quota probe.
 *
 * The probe runs in an untrusted execution target. The host caps the input so a
 * large or hostile probe output cannot exhaust host memory during the parse.
 */
export const MAX_QUOTA_ENVELOPE_CHARS = 128 * 1024;

/** Maximum length of the error string the host keeps from a probe result. */
const MAX_QUOTA_ERROR_CHARS = 500;

/** The complete set of allowed error-family values. */
const KNOWN_ERROR_FAMILIES: ReadonlySet<AdapterExecutionErrorFamily> = new Set([
  "transient_upstream",
  "provider_quota",
  "model_refusal",
  "refresh_token_reused",
  "refresh_token_expired",
  "refresh_token_invalidated",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowlistString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function allowlistErrorFamily(value: unknown): AdapterExecutionErrorFamily | null {
  return typeof value === "string" && KNOWN_ERROR_FAMILIES.has(value as AdapterExecutionErrorFamily)
    ? (value as AdapterExecutionErrorFamily)
    : null;
}

function allowlistUsedPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Copy one quota window through an allowlist.
 *
 * The function keeps only the known fields of a QuotaWindow. It drops every
 * other field. It coerces each field to the declared type or to null.
 */
function allowlistWindow(value: unknown): QuotaWindow | null {
  if (!isObject(value)) return null;
  return {
    label: allowlistString(value.label) ?? "",
    usedPercent: allowlistUsedPercent(value.usedPercent),
    resetsAt: allowlistString(value.resetsAt),
    valueLabel: allowlistString(value.valueLabel),
    detail: allowlistString(value.detail),
  };
}

function failClosed(provider: string, error: string): ProviderQuotaResult {
  return { provider, ok: false, error, windows: [] };
}

/**
 * Parse the stdout of a sandbox quota probe into a ProviderQuotaResult.
 *
 * The probe runs in an untrusted execution target. The host trusts nothing in
 * the probe output. The function does these steps:
 *  - It caps the input size.
 *  - It parses the text as JSON.
 *  - It reads a ProviderQuotaResult through a strict allowlist.
 *  - It drops every unknown field.
 *  - It forces the provider slug to the expected value.
 *  - It never returns the raw stdout, the raw stderr, or the raw envelope.
 *
 * The function fails closed. A parse error, a size overflow, or a wrong shape
 * returns an `ok:false` result with a fixed message and no raw output.
 *
 * The `quota-probe` command wraps the result in an `aggregated` field. A minimal
 * probe can also print the ProviderQuotaResult at the top level. The function
 * reads `aggregated` when it is an object, else it reads the top-level object.
 */
export function parseSandboxQuotaEnvelope(
  rawStdout: string,
  expectedProvider: string,
): ProviderQuotaResult {
  if (typeof rawStdout !== "string" || rawStdout.trim().length === 0) {
    return failClosed(expectedProvider, "Quota probe returned no output.");
  }
  if (rawStdout.length > MAX_QUOTA_ENVELOPE_CHARS) {
    return failClosed(expectedProvider, "Quota probe output exceeded the size limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStdout.trim());
  } catch {
    return failClosed(expectedProvider, "Quota probe output was not valid JSON.");
  }
  if (!isObject(parsed)) {
    return failClosed(expectedProvider, "Quota probe output was not a JSON object.");
  }

  const result = isObject(parsed.aggregated) ? parsed.aggregated : parsed;

  const windows: QuotaWindow[] = Array.isArray(result.windows)
    ? result.windows
        .map(allowlistWindow)
        .filter((window): window is QuotaWindow => window !== null)
    : [];

  const ok = result.ok === true;
  const out: ProviderQuotaResult = {
    provider: expectedProvider,
    ok,
    windows,
  };

  const source = allowlistString(result.source);
  if (source !== null) out.source = source;

  const errorFamily = allowlistErrorFamily(result.errorFamily);
  if (errorFamily !== null) out.errorFamily = errorFamily;

  if (!ok) {
    const error = allowlistString(result.error);
    out.error =
      error !== null ? error.slice(0, MAX_QUOTA_ERROR_CHARS) : "Quota probe reported a failure.";
  }

  return out;
}
