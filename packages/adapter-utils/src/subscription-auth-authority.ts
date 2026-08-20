export const SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA =
  "paperclip.subscription-auth-authority" as const;
export const SUBSCRIPTION_AUTH_AUTHORITY_VERSION = 1 as const;

export const SUBSCRIPTION_AUTH_AUTHORITY_OPAQUE_DOMAINS = [
  "auth_profile_identity",
  "auth_profile_revision",
  "account_identity",
  "account_revision",
  "principal_identity",
  "principal_revision",
  "credential_revision",
] as const;

export type SubscriptionAuthAuthorityOpaqueDomain =
  (typeof SUBSCRIPTION_AUTH_AUTHORITY_OPAQUE_DOMAINS)[number];

export type SubscriptionAuthAuthoritySignOpaque = (
  domain: SubscriptionAuthAuthorityOpaqueDomain,
  material: Uint8Array,
) => string | Promise<string>;

export type SubscriptionAuthAuthoritySource =
  | {
      kind: "resolved_user_secret_version";
      configPath: string;
      key: string;
      secretId: string;
      versionId: string;
      version: number;
      value: string;
    }
  | {
      kind: "resolved_company_secret_version";
      configPath: string;
      secretId: string;
      versionId: string;
      version: number;
      value: string;
    }
  | {
      kind: "managed_local_profile";
      profile: "codex_agent_home";
      location: string;
    }
  | {
      kind: "native_host_login";
      provider: "claude";
    };

export interface SubscriptionAuthAuthorityInspectInput {
  mode: "inspect" | "prepare";
  adapterType: string;
  companyId: string;
  agentId: string;
  /** Final, normalized local-CLI adapter config. */
  config: Record<string, unknown>;
  /** Final, normalized local-CLI environment. */
  env: Record<string, string>;
  /** Explicit transient credential/profile source selected by the server. */
  authSource: SubscriptionAuthAuthoritySource;
  /** Server-owned, domain-separated opaque signer. */
  signOpaque: SubscriptionAuthAuthoritySignOpaque;
}

export interface SubscriptionAuthAuthorityEvidence {
  evidence: "credential_bound" | "account_id_bound";
  identityFingerprint: string;
  revisionFingerprint: string;
}

export interface SubscriptionAuthAuthorityProofV1 {
  schema: typeof SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA;
  version: typeof SUBSCRIPTION_AUTH_AUTHORITY_VERSION;
  adapterType: "claude_local" | "codex_local";
  companyId: string;
  agentId: string;
  authKind: "claude_oauth_user_secret" | "codex_chatgpt_managed_profile";
  sourceKind: "user_secret_version" | "managed_local_profile";
  authProfile: SubscriptionAuthAuthorityEvidence;
  account: SubscriptionAuthAuthorityEvidence;
  principal: SubscriptionAuthAuthorityEvidence;
  credentialRevisionFingerprint: string;
}

export interface SubscriptionAuthAuthorityApplyContext {
  env: Record<string, string>;
}

export interface SubscriptionAuthHostOwnedFinalEnvEvidenceV1 {
  schema: "paperclip.subscription-auth-host-owned-final-env";
  version: 1;
  adapterType: "claude_local" | "codex_local";
}

/** Opaque transient material. Callers can apply or dispose it, never inspect it. */
export interface PreparedSubscriptionAuthAuthority {
  apply(ctx: SubscriptionAuthAuthorityApplyContext): Promise<SubscriptionAuthHostOwnedFinalEnvEvidenceV1>;
  dispose(): Promise<void>;
}

export interface SubscriptionAuthAuthorityInspection {
  proof: SubscriptionAuthAuthorityProofV1;
  prepared?: PreparedSubscriptionAuthAuthority;
}

export type InspectSubscriptionAuthAuthority = (
  input: SubscriptionAuthAuthorityInspectInput,
) => Promise<SubscriptionAuthAuthorityInspection>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_FINGERPRINT_RE = /^decision-spec-v1\.[a-f0-9]{64}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isSubscriptionAuthAuthorityFingerprint(value: unknown): value is string {
  return typeof value === "string"
    && value.length === "decision-spec-v1.".length + 64
    && OPAQUE_FINGERPRINT_RE.test(value);
}

function validEvidence(value: unknown): value is SubscriptionAuthAuthorityEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return exactKeys(evidence, ["evidence", "identityFingerprint", "revisionFingerprint"])
    && (evidence.evidence === "credential_bound" || evidence.evidence === "account_id_bound")
    && isSubscriptionAuthAuthorityFingerprint(evidence.identityFingerprint)
    && isSubscriptionAuthAuthorityFingerprint(evidence.revisionFingerprint);
}

/** Runtime guard for proof JSON before it is persisted as durable authority. */
export function isSubscriptionAuthAuthorityProof(
  value: unknown,
): value is SubscriptionAuthAuthorityProofV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  if (!exactKeys(proof, [
    "schema",
    "version",
    "adapterType",
    "companyId",
    "agentId",
    "authKind",
    "sourceKind",
    "authProfile",
    "account",
    "principal",
    "credentialRevisionFingerprint",
  ])) return false;
  const baseValid = proof.schema === SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA
    && proof.version === SUBSCRIPTION_AUTH_AUTHORITY_VERSION
    && (proof.adapterType === "claude_local" || proof.adapterType === "codex_local")
    && typeof proof.companyId === "string" && UUID_RE.test(proof.companyId)
    && typeof proof.agentId === "string" && UUID_RE.test(proof.agentId)
    && (proof.authKind === "claude_oauth_user_secret" || proof.authKind === "codex_chatgpt_managed_profile")
    && (proof.sourceKind === "user_secret_version" || proof.sourceKind === "managed_local_profile")
    && validEvidence(proof.authProfile)
    && validEvidence(proof.account)
    && validEvidence(proof.principal)
    && isSubscriptionAuthAuthorityFingerprint(proof.credentialRevisionFingerprint);
  if (!baseValid) return false;
  const expectedEvidence = proof.adapterType === "claude_local" ? "credential_bound" : "account_id_bound";
  const evidenceMatches = [proof.authProfile, proof.account, proof.principal]
    .every((entry) => (entry as SubscriptionAuthAuthorityEvidence).evidence === expectedEvidence);
  if (!evidenceMatches) return false;
  return proof.adapterType === "claude_local"
    ? proof.authKind === "claude_oauth_user_secret" && proof.sourceKind === "user_secret_version"
    : proof.authKind === "codex_chatgpt_managed_profile" && proof.sourceKind === "managed_local_profile";
}

export function isSubscriptionAuthAuthorityInspectionForMode(
  value: unknown,
  mode: "inspect" | "prepare",
): value is SubscriptionAuthAuthorityInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const inspection = value as Record<string, unknown>;
  if (!isSubscriptionAuthAuthorityProof(inspection.proof)) return false;
  if (mode === "inspect") return exactKeys(inspection, ["proof"]);
  if (!exactKeys(inspection, ["proof", "prepared"])) return false;
  if (!inspection.prepared || typeof inspection.prepared !== "object") return false;
  const prepared = inspection.prepared as Record<string, unknown>;
  return exactKeys(prepared, ["apply", "dispose"])
    && typeof prepared.apply === "function"
    && typeof prepared.dispose === "function";
}
