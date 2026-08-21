import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  InspectSubscriptionAuthAuthority,
  PreparedInstructionSnapshot,
  PreparedSubscriptionAuthAuthority,
  SubscriptionAuthAuthorityProofV1,
  SubscriptionAuthAuthoritySource,
  SubscriptionOnlyBillingCapability,
} from "@paperclipai/adapter-utils";
import {
  isSubscriptionAuthAuthorityProof,
  SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
} from "@paperclipai/adapter-utils";
import { conflict } from "../errors.js";
import type { RuntimeSecretManifestEntry } from "./secrets.js";

export const EXECUTION_PROFILE_BINDING_VERSION = 1 as const;
export const EXECUTION_PROFILE_PROJECTION_SCHEMA =
  "paperclip.governed-execution-profile" as const;

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_INSTRUCTIONS_BYTES = 4 * 1024 * 1024;
const SECURITY_CONFIG_IGNORED_KEYS = new Set([
  "cwd",
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
]);

export type GovernedExecutionProfileProjectionV1 = {
  schema: typeof EXECUTION_PROFILE_PROJECTION_SCHEMA;
  version: typeof EXECUTION_PROFILE_BINDING_VERSION;
  companyId: string;
  agentId: string;
  issueId: string | null;
  adapterType: "claude_local" | "codex_local";
  billingPolicy: "subscription_only";
  engine: "cli";
  environment: { id: string; driver: "local" };
  agentExecutionProfileRevision: number;
  issueAssigneeProfileRevision: number | null;
  securityConfigSha256: string;
  instructionsSha256: string;
  authorityProofSha256: string;
};

export type InspectedExecutionProfileBinding = {
  projection: GovernedExecutionProfileProjectionV1;
  digest: string;
  authorityProof: SubscriptionAuthAuthorityProofV1;
  prepared: PreparedSubscriptionAuthAuthority | null;
};

export type InstructionFileSnapshot = {
  sha256: string;
  prepared: PreparedInstructionSnapshot | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function hasExactSubscriptionOnlyBillingCapability(
  value: SubscriptionOnlyBillingCapability | undefined,
): value is SubscriptionOnlyBillingCapability {
  return value !== undefined
    && executionProfileSha256(value) === executionProfileSha256(SUBSCRIPTION_ONLY_BILLING_CAPABILITY);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

export function executionProfileSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJsonValue(value))).digest("hex");
}

function replaceConfigPath(
  target: Record<string, unknown>,
  configPath: string,
  replacement: Record<string, unknown>,
): void {
  const path = configPath.split(".").filter(Boolean);
  if (path.length === 0) return;
  let parent = target;
  for (const segment of path.slice(0, -1)) {
    const next = record(parent[segment]);
    parent[segment] = next;
    parent = next;
  }
  parent[path.at(-1)!] = replacement;
}

function securityConfigProjection(
  resolvedConfig: Record<string, unknown>,
  secretManifest: readonly RuntimeSecretManifestEntry[],
): Record<string, unknown> {
  const projected = structuredClone(resolvedConfig);
  for (const key of SECURITY_CONFIG_IGNORED_KEYS) delete projected[key];
  for (const entry of secretManifest) {
    if (entry.outcome !== "success") continue;
    replaceConfigPath(projected, entry.configPath, {
      type: "resolved_secret_version",
      secretId: entry.secretId,
      secretScope: entry.secretScope,
      secretKey: entry.secretKey,
      versionId: entry.versionId,
      version: entry.version,
    });
  }
  return projected;
}

function normalizedEnv(config: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(config.env))) {
    if (typeof value !== "string") {
      throw conflict("Execution profile environment is not fully resolved", {
        code: "execution_profile_environment_unresolved",
      });
    }
    env[key] = value;
  }
  return env;
}

function exactClaudeAuthSource(input: {
  resolvedConfig: Record<string, unknown>;
  secretManifest: readonly RuntimeSecretManifestEntry[];
}): SubscriptionAuthAuthoritySource {
  const entries = input.secretManifest.filter((entry) =>
    entry.outcome === "success"
    && entry.configPath === "env.CLAUDE_CODE_OAUTH_TOKEN"
    && entry.envKey === "CLAUDE_CODE_OAUTH_TOKEN"
    && entry.secretScope === "user"
    && entry.secretKey === "CLAUDE_CODE_OAUTH_TOKEN"
  );
  const entry = entries.length === 1 ? entries[0]! : null;
  const value = record(input.resolvedConfig.env).CLAUDE_CODE_OAUTH_TOKEN;
  if (!entry || typeof value !== "string" || !value) {
    throw conflict("Claude execution profile lacks one exact owner OAuth secret version", {
      code: "execution_profile_auth_authority_missing",
    });
  }
  return {
    kind: "resolved_user_secret_version",
    configPath: entry.configPath,
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    secretId: entry.secretId,
    versionId: entry.versionId,
    version: entry.version,
    value,
  };
}

export async function inspectExecutionProfileBinding(input: {
  mode: "inspect" | "prepare";
  companyId: string;
  agentId: string;
  issueId: string | null;
  adapterType: string;
  resolvedConfig: Record<string, unknown>;
  secretManifest: readonly RuntimeSecretManifestEntry[];
  environment: { id: string; driver: string };
  agentExecutionProfileRevision: number;
  issueAssigneeProfileRevision: number | null;
  instructionsSha256: string;
  subscriptionOnlyBilling: SubscriptionOnlyBillingCapability | undefined;
  inspectSubscriptionAuthAuthority: InspectSubscriptionAuthAuthority | undefined;
  codexManagedHome: string | null;
}): Promise<InspectedExecutionProfileBinding> {
  if (
    (input.adapterType !== "claude_local" && input.adapterType !== "codex_local")
    || input.resolvedConfig.billingPolicy !== "subscription_only"
    || input.resolvedConfig.engine !== "cli"
    || input.environment.driver !== "local"
    || !Number.isSafeInteger(input.agentExecutionProfileRevision)
    || input.agentExecutionProfileRevision <= 0
    || (input.issueId === null) !== (input.issueAssigneeProfileRevision === null)
    || (
      input.issueAssigneeProfileRevision !== null
      && (
        !Number.isSafeInteger(input.issueAssigneeProfileRevision)
        || input.issueAssigneeProfileRevision <= 0
      )
    )
    || !SHA256_RE.test(input.instructionsSha256)
    || !hasExactSubscriptionOnlyBillingCapability(input.subscriptionOnlyBilling)
    || !input.inspectSubscriptionAuthAuthority
  ) {
    throw conflict("Execution profile is not an attested local subscription profile", {
      code: "execution_profile_unsupported",
    });
  }
  const env = normalizedEnv(input.resolvedConfig);
  const authSource: SubscriptionAuthAuthoritySource = input.adapterType === "claude_local"
    ? exactClaudeAuthSource(input)
    : input.codexManagedHome
      ? {
          kind: "managed_local_profile",
          profile: "codex_agent_home",
          location: input.codexManagedHome,
        }
      : (() => {
          throw conflict("Codex execution profile lacks its managed ChatGPT profile", {
            code: "execution_profile_auth_authority_missing",
          });
        })();
  const inspection = await input.inspectSubscriptionAuthAuthority({
    mode: input.mode,
    adapterType: input.adapterType,
    companyId: input.companyId,
    agentId: input.agentId,
    config: input.resolvedConfig,
    env,
    authSource,
    // The server registry replaces this caller value with its own signer.
    signOpaque: async () => {
      throw new Error("The server subscription authority signer was not installed");
    },
  });
  if (!isSubscriptionAuthAuthorityProof(inspection.proof)) {
    await inspection.prepared?.dispose().catch(() => undefined);
    throw conflict("Execution profile returned invalid authentication authority", {
      code: "execution_profile_auth_authority_invalid",
    });
  }
  const authorityProofSha256 = executionProfileSha256(inspection.proof);
  const projection: GovernedExecutionProfileProjectionV1 = {
    schema: EXECUTION_PROFILE_PROJECTION_SCHEMA,
    version: EXECUTION_PROFILE_BINDING_VERSION,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    adapterType: input.adapterType,
    billingPolicy: "subscription_only",
    engine: "cli",
    environment: { id: input.environment.id, driver: "local" },
    agentExecutionProfileRevision: input.agentExecutionProfileRevision,
    issueAssigneeProfileRevision: input.issueAssigneeProfileRevision,
    securityConfigSha256: executionProfileSha256(
      securityConfigProjection(input.resolvedConfig, input.secretManifest),
    ),
    instructionsSha256: input.instructionsSha256,
    authorityProofSha256,
  };
  return {
    projection,
    digest: executionProfileSha256(projection),
    authorityProof: inspection.proof,
    prepared: inspection.prepared ?? null,
  };
}

export async function readInstructionFileSnapshot(
  config: Record<string, unknown>,
): Promise<InstructionFileSnapshot> {
  const filePath = typeof config.instructionsFilePath === "string"
    ? config.instructionsFilePath.trim()
    : "";
  if (!filePath) {
    return {
      sha256: executionProfileSha256({ kind: "none" }),
      prepared: null,
    };
  }
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_INSTRUCTIONS_BYTES) {
    throw conflict("Execution profile instructions are not one bounded regular file", {
      code: "execution_profile_instructions_unsafe",
    });
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size > MAX_INSTRUCTIONS_BYTES
    ) {
      throw conflict("Execution profile instructions changed while being inspected", {
        code: "execution_profile_instructions_changed",
      });
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) {
        throw conflict("Execution profile instructions could not be read completely", {
          code: "execution_profile_instructions_incomplete",
        });
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw conflict("Execution profile instructions changed while being inspected", {
        code: "execution_profile_instructions_changed",
      });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw conflict("Execution profile instructions are not valid UTF-8", {
        code: "execution_profile_instructions_invalid_utf8",
      });
    }
    return {
      sha256,
      prepared: {
        sourcePath: filePath,
        contents,
        sha256,
      },
    };
  } finally {
    await handle.close();
  }
}

export async function instructionFileSha256(config: Record<string, unknown>): Promise<string> {
  return (await readInstructionFileSnapshot(config)).sha256;
}

export function executionProfileBindingsMatch(
  stored: {
    digest: string;
    projection: unknown;
    authorityIdentity: unknown;
  },
  inspected: InspectedExecutionProfileBinding,
): boolean {
  const authorityIdentity = record(stored.authorityIdentity);
  return stored.digest === inspected.digest
    && executionProfileSha256(stored.projection) === executionProfileSha256(inspected.projection)
    && executionProfileSha256(authorityIdentity.profile) === executionProfileSha256(inspected.authorityProof);
}

export function inspectedExecutionProfileBindingMatchesScope(
  value: unknown,
  expected: {
    companyId: string;
    agentId: string;
    issueId: string;
    agentExecutionProfileRevision: number;
    issueAssigneeProfileRevision: number;
  },
): value is InspectedExecutionProfileBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (!exactKeys(binding, ["projection", "digest", "authorityProof", "prepared"])) return false;
  if (binding.prepared !== null || typeof binding.digest !== "string" || !SHA256_RE.test(binding.digest)) {
    return false;
  }
  const projection = record(binding.projection);
  if (!exactKeys(projection, [
    "schema",
    "version",
    "companyId",
    "agentId",
    "issueId",
    "adapterType",
    "billingPolicy",
    "engine",
    "environment",
    "agentExecutionProfileRevision",
    "issueAssigneeProfileRevision",
    "securityConfigSha256",
    "instructionsSha256",
    "authorityProofSha256",
  ])) return false;
  const environment = record(projection.environment);
  const authorityProof = binding.authorityProof;
  return projection.schema === EXECUTION_PROFILE_PROJECTION_SCHEMA
    && projection.version === EXECUTION_PROFILE_BINDING_VERSION
    && projection.companyId === expected.companyId
    && projection.agentId === expected.agentId
    && projection.issueId === expected.issueId
    && (projection.adapterType === "claude_local" || projection.adapterType === "codex_local")
    && projection.billingPolicy === "subscription_only"
    && projection.engine === "cli"
    && exactKeys(environment, ["id", "driver"])
    && typeof environment.id === "string"
    && environment.id.length > 0
    && environment.driver === "local"
    && projection.agentExecutionProfileRevision === expected.agentExecutionProfileRevision
    && projection.issueAssigneeProfileRevision === expected.issueAssigneeProfileRevision
    && typeof projection.securityConfigSha256 === "string"
    && SHA256_RE.test(projection.securityConfigSha256)
    && typeof projection.instructionsSha256 === "string"
    && SHA256_RE.test(projection.instructionsSha256)
    && typeof projection.authorityProofSha256 === "string"
    && projection.authorityProofSha256 === executionProfileSha256(authorityProof)
    && isSubscriptionAuthAuthorityProof(authorityProof)
    && authorityProof.companyId === expected.companyId
    && authorityProof.agentId === expected.agentId
    && authorityProof.adapterType === projection.adapterType
    && binding.digest === executionProfileSha256(projection);
}
