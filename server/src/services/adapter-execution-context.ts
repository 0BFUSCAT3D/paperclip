import type { Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import type { environmentService } from "./environments.js";
import type { environmentRuntimeService } from "./environment-runtime.js";

/**
 * The resolved execution context for one adapter test or quota probe.
 *
 * - `executionTarget` is `null` for a host probe (no environment / local
 *   driver / a resolution that could not build a target).
 * - `release` rolls back any acquired lease. The caller MUST always invoke it,
 *   typically in a `finally` block. It is a no-op when there is no lease.
 */
export interface AdapterTestExecutionContext {
  executionTarget: AdapterExecutionTarget | null;
  environmentName: string | null;
  fallbackChecks: AdapterEnvironmentCheck[];
  sandboxIdentityCheck?: AdapterEnvironmentCheck | null;
  release: (status?: "released" | "failed") => Promise<void>;
}

/** The dependencies the resolver needs. */
export interface AdapterTestExecutionContextResolverDeps {
  db: Db;
  environmentsSvc: ReturnType<typeof environmentService>;
  environmentRuntime: ReturnType<typeof environmentRuntimeService>;
}

/** Resolve one execution context for an adapter in a company environment. */
export type ResolveAdapterTestExecutionContext = (input: {
  companyId: string;
  adapterType: string;
  environmentId: string | null;
}) => Promise<AdapterTestExecutionContext>;

function readMetadataString(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildSandboxIdentityCheck(input: {
  environmentName: string;
  lease: {
    id: string;
    provider?: string | null;
    providerLeaseId?: string | null;
    metadata?: Record<string, unknown> | null;
  };
}): AdapterEnvironmentCheck {
  const metadata = input.lease.metadata ?? {};
  const provider = input.lease.provider ?? readMetadataString(metadata, ["provider"]);
  const sandboxId = readMetadataString(metadata, ["sandboxId", "sandboxID", "sandbox_id", "id"]);
  const sandboxName = readMetadataString(metadata, ["sandboxName", "sandbox_name", "name"]);
  const snapshotRef = readMetadataString(metadata, [
    "snapshot",
    "snapshotId",
    "snapshotID",
    "snapshotRef",
    "snapshot_ref",
    "templateRef",
    "template_ref",
    "templateId",
    "templateID",
    "image",
    "imageId",
    "imageID",
    "imageRef",
    "image_ref",
  ]);
  const templateKind = readMetadataString(metadata, [
    "templateKind",
    "template_kind",
    "templateRefKind",
    "template_ref_kind",
  ]);
  const detailParts = [
    `paperclipLeaseId=${input.lease.id}`,
    input.lease.providerLeaseId ? `providerLeaseId=${input.lease.providerLeaseId}` : null,
    provider ? `provider=${provider}` : null,
    sandboxId ? `sandboxId=${sandboxId}` : null,
    sandboxName ? `sandboxName=${sandboxName}` : null,
    snapshotRef ? `${templateKind ? `${templateKind}Ref` : "snapshotOrTemplateRef"}=${snapshotRef}` : null,
  ].filter((part): part is string => Boolean(part));

  return {
    code: "sandbox_test_identity",
    level: "info",
    message: `Sandbox test identity for "${input.environmentName}".`,
    detail: detailParts.join("; "),
    hint: "Use these provider-neutral IDs when comparing model-test output with provider logs or refreshed sandbox snapshots.",
  };
}

/**
 * Build the resolver that picks the execution target an adapter probes.
 *
 * - No environmentId / local environment → returns a `null` target so the
 *   adapter probes the Paperclip host (legacy behavior).
 * - SSH environment → builds an SSH execution target from the environment
 *   config so the adapter probes the remote box. No lease is required:
 *   the SSH spec is fully derived from the saved environment config.
 * - Sandbox / plugin environments → acquires an ad-hoc lease, realizes the
 *   workspace, and resolves a sandbox execution target wired to the runtime
 *   so the adapter probe runs inside the sandbox the same way a heartbeat
 *   would. The returned `release` callback rolls the lease back when the
 *   caller is done.
 *
 * The caller MUST always invoke `release()` (typically in a `finally` block).
 */
export function createAdapterTestExecutionContextResolver(
  deps: AdapterTestExecutionContextResolverDeps,
): ResolveAdapterTestExecutionContext {
  const { db, environmentsSvc, environmentRuntime } = deps;

  return async function resolveAdapterTestExecutionContext(input: {
    companyId: string;
    adapterType: string;
    environmentId: string | null;
  }): Promise<AdapterTestExecutionContext> {
    const noopRelease = async () => {};

    if (!input.environmentId) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [],
        release: noopRelease,
      };
    }

    const environment = await environmentsSvc.getById(input.environmentId);
    if (!environment) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [
          {
            code: "environment_not_found",
            level: "warn",
            message: "Selected environment was not found. The test did not run.",
          },
        ],
        release: noopRelease,
      };
    }

    if (environment.driver === "local") {
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [],
        release: noopRelease,
      };
    }

    if (environment.driver === "ssh") {
      try {
        const target = await resolveEnvironmentExecutionTarget({
          db,
          companyId: input.companyId,
          adapterType: input.adapterType,
          environment: {
            id: environment.id,
            driver: environment.driver,
            config: environment.config ?? null,
          },
          leaseMetadata: null,
        });
        if (target) {
          return {
            executionTarget: target,
            environmentName: environment.name,
            fallbackChecks: [],
            release: noopRelease,
          };
        }
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_unavailable",
              level: "warn",
              message:
                `Could not resolve an execution target for environment "${environment.name}". The test did not run.`,
            },
          ],
          release: noopRelease,
        };
      } catch (err) {
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_failed",
              level: "warn",
              message:
                `Could not connect to environment "${environment.name}" to run the test.`,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
          release: noopRelease,
        };
      }
    }

    // sandbox / plugin / other remote drivers: spin up an ad-hoc lease, realize
    // the workspace inside the box, and run the same probe SSH uses against
    // a sandbox execution target wired to the environment runtime.
    //
    // We pass `heartbeatRunId: null` because there's no heartbeat run for an
    // operator-initiated `Test` invocation — the leases table FKs heartbeat
    // run id to heartbeat_runs.id, and we don't want to manufacture a fake
    // run row. Cleanup goes through the driver's `releaseRunLease` directly
    // (by lease record), since the batch helper queries by heartbeatRunId.
    //
    // Sandbox tests boot a fresh throwaway sandbox (never resume a retained
    // agent lease) and archive it on release instead of deleting it, so the
    // operator can inspect the exact sandbox from the provider dashboard while
    // provider-side expiry reaps it later.
    const testEnvironment = environment.driver === "sandbox"
      ? {
          ...environment,
          config: {
            ...(environment.config ?? {}),
            reuseLease: false,
            archiveOnRelease: true,
          },
        }
      : environment;
    let leaseRecord: Awaited<ReturnType<typeof environmentRuntime.acquireRunLease>>;
    try {
      leaseRecord = await environmentRuntime.acquireRunLease({
        companyId: input.companyId,
        environment: testEnvironment,
        issueId: null,
        heartbeatRunId: null,
        persistedExecutionWorkspace: null,
        // Apply the active custom-image template so the Test boots with the
        // operator's captured sandbox customizations and prepared image state,
        // matching what real agent runs use. Without this the test would
        // silently fall back to the base image.
        applyCustomImageTemplate: true,
      });
    } catch (err) {
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_lease_acquire_failed",
            level: "error",
            message: `Could not acquire a lease for environment "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
            hint: "Check the environment's provider credentials and quota.",
          },
        ],
        release: noopRelease,
      };
    }

    const driver = environmentRuntime.getDriver(environment.driver);
    const releaseLease = async (status: "released" | "failed" = "released") => {
      try {
        if (driver) {
          await driver.releaseRunLease({
            environment: testEnvironment,
            lease: leaseRecord.lease,
            status,
          });
        } else {
          await environmentsSvc.releaseLease(leaseRecord.lease.id, status);
        }
      } catch (err) {
        // Cleanup failures must not mask the test result.
        // eslint-disable-next-line no-console
        console.warn(
          `[adapter-test] Failed to release lease ${leaseRecord.lease.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    let realizedCwd: string | null = null;
    try {
      const realized = await environmentRuntime.realizeWorkspace({
        environment: testEnvironment,
        lease: leaseRecord.lease,
        // No host workspace to copy for a Test invocation; sandbox/plugin
        // realize implementations use the lease metadata's remoteCwd to
        // create the working directory inside the box.
        workspace: {},
      });
      realizedCwd =
        typeof realized.cwd === "string" && realized.cwd.trim().length > 0
          ? realized.cwd.trim()
          : null;
    } catch (err) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_workspace_realize_failed",
            level: "error",
            message: `Could not realize a workspace inside "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        release: noopRelease,
      };
    }

    let target: AdapterExecutionTarget | null;
    try {
      // Prefer the cwd the realize step returned; fall back to lease metadata.
      const leaseMetadataForTarget: Record<string, unknown> | null =
        realizedCwd
          ? { ...(leaseRecord.lease.metadata ?? {}), remoteCwd: realizedCwd }
          : (leaseRecord.lease.metadata as Record<string, unknown> | null) ?? null;

      target = await resolveEnvironmentExecutionTarget({
        db,
        companyId: input.companyId,
        adapterType: input.adapterType,
        environment: {
          id: testEnvironment.id,
          driver: testEnvironment.driver,
          config: testEnvironment.config ?? null,
        },
        leaseId: leaseRecord.lease.id,
        leaseMetadata: leaseMetadataForTarget,
        lease: leaseRecord.lease,
        environmentRuntime,
      });
    } catch (err) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_target_failed",
            level: "error",
            message: `Could not resolve a sandbox execution target for "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        release: noopRelease,
      };
    }

    if (!target) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_target_unsupported",
            level: "warn",
            message:
              `Adapter "${input.adapterType}" is not allowed in "${environment.name}" environments.`,
          },
        ],
        release: noopRelease,
      };
    }

    return {
      executionTarget: target,
      environmentName: environment.name,
      fallbackChecks: [],
      sandboxIdentityCheck: buildSandboxIdentityCheck({
        environmentName: environment.name,
        lease: leaseRecord.lease,
      }),
      release: releaseLease,
    };
  };
}
