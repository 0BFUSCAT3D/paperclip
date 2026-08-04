import type { ProviderQuotaResult } from "@paperclipai/shared";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { parseSandboxQuotaEnvelope } from "@paperclipai/adapter-utils/quota-envelope";
import { logger as defaultLogger } from "../middleware/logger.js";
import { listServerAdapters } from "../adapters/registry.js";
import type { ResolveAdapterTestExecutionContext } from "./adapter-execution-context.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * The minimal logger the quota service needs.
 *
 * The service logs only data-minimized fields (environment id, adapter type,
 * lease status, timings, and a bounded error category). It never logs
 * credentials, environment variables, probe stdout, probe stderr, or a raw
 * envelope.
 */
export interface QuotaWindowsLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Options for {@link fetchAllQuotaWindows}. */
export interface FetchAllQuotaWindowsOptions {
  /**
   * The selected environment. When absent or `null`, every adapter probes the
   * Paperclip host, the same as before this argument existed.
   */
  environmentId?: string | null;
  /** The company that owns the environment. Required to resolve a target. */
  companyId?: string | null;
  /**
   * Resolves one execution target per adapter. Injected so the route wires the
   * database-backed resolver and tests inject a fake one. When absent, every
   * adapter probes the host.
   */
  resolveExecutionContext?: ResolveAdapterTestExecutionContext;
  /** The logger. Defaults to the server logger. */
  logger?: QuotaWindowsLogger;
}

function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/** True when the target runs the probe in an untrusted sandbox. */
function isSandboxTarget(target: AdapterExecutionTarget | null): boolean {
  return target?.kind === "remote" && target.transport === "sandbox";
}

/**
 * Reduce an error to a short, safe category. The service logs this instead of
 * the raw message, because a probe error can carry stderr or secret arguments.
 */
function errorCategoryFor(err: unknown): string {
  if (err instanceof Error && typeof err.name === "string" && err.name.length > 0) {
    return err.name;
  }
  return "unknown_error";
}

/**
 * Asks each registered adapter for its provider quota windows and aggregates the results.
 * Adapters that don't implement getQuotaWindows() are silently skipped.
 * Individual adapter failures are caught and returned as error results rather than
 * letting one provider's outage block the entire response.
 *
 * When the caller selects an environment (and injects a resolver), the service
 * resolves one execution target per adapter and dispatches each probe into that
 * target. It releases every acquired lease exactly once in a `finally` block. A
 * `null` or `local` environment keeps the exact host behavior.
 */
export async function fetchAllQuotaWindows(
  options: FetchAllQuotaWindowsOptions = {},
): Promise<ProviderQuotaResult[]> {
  const {
    environmentId = null,
    companyId = null,
    resolveExecutionContext,
    logger = defaultLogger,
  } = options;

  const adapters = listServerAdapters().filter((a) => a.getQuotaWindows != null);

  const useEnvironment =
    Boolean(environmentId) && Boolean(companyId) && typeof resolveExecutionContext === "function";

  const settled = await Promise.allSettled(
    adapters.map((adapter) => {
      if (useEnvironment) {
        // The environment path owns its own per-adapter timeout and lease
        // release, so a slow probe cannot leak a lease (C4). Do not wrap it in
        // `withQuotaTimeout`; that outer timeout can return before the release
        // runs.
        return fetchOneQuotaWindowInEnvironment({
          adapter,
          companyId: companyId!,
          environmentId: environmentId!,
          resolveExecutionContext: resolveExecutionContext!,
          logger,
        });
      }
      return withQuotaTimeout(adapter.type, adapter.getQuotaWindows!());
    }),
  );

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return {
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    };
  });
}

/**
 * Resolve one execution target for an adapter, dispatch its probe into that
 * target, and release the lease exactly once.
 *
 * The function releases the lease in a `finally` block. It releases the lease
 * on a probe throw, on a resolution that produced no target, and on a probe
 * timeout (C4). It sets the `failed` status on any failure. It never logs the
 * probe stdout, the probe stderr, or a raw envelope (C5).
 */
async function fetchOneQuotaWindowInEnvironment(args: {
  adapter: { type: string; getQuotaWindows?: (ctx?: { executionTarget: AdapterExecutionTarget | null }) => Promise<ProviderQuotaResult> };
  companyId: string;
  environmentId: string;
  resolveExecutionContext: ResolveAdapterTestExecutionContext;
  logger: QuotaWindowsLogger;
}): Promise<ProviderQuotaResult> {
  const { adapter, companyId, environmentId, resolveExecutionContext, logger } = args;
  const provider = providerSlugForAdapterType(adapter.type);
  const resolveStartedAt = Date.now();

  let context;
  try {
    context = await resolveExecutionContext({
      companyId,
      adapterType: adapter.type,
      environmentId,
    });
  } catch (err) {
    logger.warn(
      {
        environmentId,
        adapterType: adapter.type,
        provider,
        errorCategory: errorCategoryFor(err),
        resolveMs: Date.now() - resolveStartedAt,
      },
      "quota environment resolve failed",
    );
    return {
      provider,
      ok: false,
      error: "Could not resolve an execution target for the selected environment.",
      windows: [],
    };
  }

  // C5: log only the environment id, the adapter type, the provider, the target
  // presence flag, and the timing. Do not log the environment name, the config,
  // the env vars, or any probe output.
  logger.info(
    {
      environmentId,
      adapterType: adapter.type,
      provider,
      hasTarget: context.executionTarget != null,
      resolveMs: Date.now() - resolveStartedAt,
    },
    "quota environment resolved",
  );

  let releaseStatus: "released" | "failed" = "released";
  const probeStartedAt = Date.now();
  try {
    // The resolver returned a target it could not build, e.g. the environment
    // was not found or a lease could not be acquired. Do not fall back to the
    // host probe; the operator asked for a specific environment. Return a
    // failed result and release below.
    if (!context.executionTarget && context.fallbackChecks.length > 0) {
      releaseStatus = "failed";
      logger.warn(
        {
          environmentId,
          adapterType: adapter.type,
          provider,
          errorCategory: context.fallbackChecks[0]!.code,
        },
        "quota environment target unavailable",
      );
      return {
        provider,
        ok: false,
        error: "The selected environment could not run the quota probe.",
        windows: [],
      };
    }

    const raw = await dispatchProbeWithTimeout({
      adapter,
      executionTarget: context.executionTarget,
      provider,
    });
    if (raw.timedOut) {
      releaseStatus = "failed";
      logger.warn(
        {
          environmentId,
          adapterType: adapter.type,
          provider,
          probeMs: Date.now() - probeStartedAt,
        },
        "quota probe timed out",
      );
      return {
        provider,
        ok: false,
        error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
        windows: [],
      };
    }

    // The sandbox probe output is untrusted. Run it through the strict
    // allowlist a second time so an adapter that returns an unexpected field
    // cannot leak it into the aggregated result or the logs (C2). The
    // helper drops unknown fields, caps the size, and forces the provider slug.
    const result = isSandboxTarget(context.executionTarget)
      ? parseSandboxQuotaEnvelope(JSON.stringify(raw.value), provider)
      : raw.value;

    if (!result.ok) releaseStatus = "failed";
    return result;
  } catch (err) {
    releaseStatus = "failed";
    logger.error(
      {
        environmentId,
        adapterType: adapter.type,
        provider,
        errorCategory: errorCategoryFor(err),
        probeMs: Date.now() - probeStartedAt,
      },
      "quota probe failed",
    );
    return {
      provider,
      ok: false,
      error: "The quota probe failed in the selected environment.",
      windows: [],
    };
  } finally {
    await context.release(releaseStatus);
    logger.info(
      {
        environmentId,
        adapterType: adapter.type,
        provider,
        leaseStatus: releaseStatus,
        durationMs: Date.now() - resolveStartedAt,
      },
      "quota environment lease released",
    );
  }
}

/**
 * Dispatch one adapter probe and bound it with the per-adapter timeout.
 *
 * The function returns `{ timedOut: true }` when the timeout wins. The caller
 * still releases the lease, so a hung probe cannot leak a lease (C4).
 */
async function dispatchProbeWithTimeout(args: {
  adapter: { getQuotaWindows?: (ctx?: { executionTarget: AdapterExecutionTarget | null }) => Promise<ProviderQuotaResult> };
  executionTarget: AdapterExecutionTarget | null;
  provider: string;
}): Promise<{ timedOut: false; value: ProviderQuotaResult } | { timedOut: true }> {
  const probe = args.adapter.getQuotaWindows!({ executionTarget: args.executionTarget });
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race<{ timedOut: false; value: ProviderQuotaResult } | { timedOut: true }>([
      probe.then((value) => ({ timedOut: false as const, value })),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ timedOut: true as const }), QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    // The probe may still settle after a timeout. Swallow its result so an
    // abandoned rejection does not surface as an unhandled promise rejection.
    void probe.catch(() => {});
  }
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult>,
): Promise<ProviderQuotaResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
