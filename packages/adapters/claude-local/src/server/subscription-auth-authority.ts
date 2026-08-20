import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  SubscriptionBillingPolicyFailure,
  classifySubscriptionOnlyProviderPolicy,
  isSubscriptionAuthAuthorityFingerprint,
  type PreparedSubscriptionAuthAuthority,
  type SubscriptionAuthAuthorityEvidence,
  type SubscriptionAuthAuthorityInspectInput,
  type SubscriptionAuthAuthorityInspection,
  type SubscriptionAuthAuthorityOpaqueDomain,
  type SubscriptionAuthHostOwnedFinalEnvEvidenceV1,
} from "@paperclipai/adapter-utils";

const OAUTH_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";
const OAUTH_CONFIG_PATH = `env.${OAUTH_ENV_KEY}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fail(message: string): never {
  throw new SubscriptionBillingPolicyFailure("subscription_auth_unverifiable", message);
}

function encodeParts(parts: readonly (string | Uint8Array)[]): Buffer {
  const encoded = parts.map((part) => typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part));
  const output = Buffer.alloc(encoded.reduce((total, part) => total + 4 + part.length, 0));
  let offset = 0;
  for (const part of encoded) {
    output.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(output, offset);
    offset += part.length;
  }
  for (const part of encoded) part.fill(0);
  return output;
}

async function sign(
  input: SubscriptionAuthAuthorityInspectInput,
  domain: SubscriptionAuthAuthorityOpaqueDomain,
  material: Uint8Array,
): Promise<string> {
  const fingerprint = await input.signOpaque(domain, material);
  if (!isSubscriptionAuthAuthorityFingerprint(fingerprint)) {
    fail("Subscription auth authority signer returned no opaque evidence.");
  }
  return fingerprint;
}

type ClaudePreparedFinalEnv = {
  token: string;
  home: string;
  configDir: string;
  xdgConfigHome: string;
  xdgDataHome: string;
};

const preparedFinalEnvironments = new WeakMap<object, ClaudePreparedFinalEnv>();

export function isClaudePreparedSubscriptionAuthFinalEnv(
  evidence: unknown,
  env: Record<string, string>,
): evidence is SubscriptionAuthHostOwnedFinalEnvEvidenceV1 {
  if (!evidence || typeof evidence !== "object") return false;
  const expected = preparedFinalEnvironments.get(evidence);
  return Boolean(
    expected &&
    env.CLAUDE_CODE_OAUTH_TOKEN === expected.token &&
    env.HOME === expected.home &&
    env.CLAUDE_CONFIG_DIR === expected.configDir &&
    env.XDG_CONFIG_HOME === expected.xdgConfigHome &&
    env.XDG_DATA_HOME === expected.xdgDataHome
  );
}

function clearClaudeHostAuthAndInjectionEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper === "HOME" ||
      upper === "XDG_CONFIG_HOME" ||
      upper === "XDG_DATA_HOME" ||
      upper === "CLAUDE_CONFIG_DIR" ||
      upper === "HTTP_PROXY" ||
      upper === "HTTPS_PROXY" ||
      upper === "ALL_PROXY" ||
      upper === "NO_PROXY" ||
      upper === "NODE_OPTIONS" ||
      upper === "NODE_PATH" ||
      upper === "NODE_EXTRA_CA_CERTS" ||
      upper === "NODE_TLS_REJECT_UNAUTHORIZED" ||
      upper === "SSL_CERT_FILE" ||
      upper === "SSL_CERT_DIR" ||
      upper === "LD_PRELOAD" ||
      upper.startsWith("DYLD_") ||
      upper === "BASH_ENV" ||
      upper === "ENV" ||
      upper.startsWith("ANTHROPIC_") ||
      upper.startsWith("CLAUDE_CODE_") ||
      upper.startsWith("CLAUDE_") ||
      upper.startsWith("AWS_") ||
      upper.startsWith("GOOGLE_") ||
      upper.startsWith("GCLOUD_") ||
      upper.startsWith("CLOUD_ML_") ||
      upper.startsWith("AZURE_")
    ) {
      delete env[key];
    }
  }
}

async function createPrivateClaudeHome(): Promise<Omit<ClaudePreparedFinalEnv, "token">> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-auth-authority-"));
  const configDir = path.join(home, ".claude");
  const xdgConfigHome = path.join(home, ".config");
  const xdgDataHome = path.join(home, ".local", "share");
  try {
    await fs.chmod(home, 0o700);
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(xdgConfigHome, { recursive: true, mode: 0o700 });
    await fs.mkdir(xdgDataHome, { recursive: true, mode: 0o700 });
    await Promise.all([configDir, xdgConfigHome, xdgDataHome].map((dir) => fs.chmod(dir, 0o700)));
    return { home, configDir, xdgConfigHome, xdgDataHome };
  } catch (error) {
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function makePreparedOAuth(
  token: Buffer,
  privateHome: Omit<ClaudePreparedFinalEnv, "token">,
): PreparedSubscriptionAuthAuthority {
  const applied = new Set<Record<string, string>>();
  let disposed = false;
  let disposing: Promise<void> | null = null;
  return {
    async apply(ctx) {
      if (disposed) fail("Prepared Claude subscription authority has been disposed.");
      clearClaudeHostAuthAndInjectionEnv(ctx.env);
      const tokenString = token.toString("utf8");
      ctx.env[OAUTH_ENV_KEY] = tokenString;
      ctx.env.HOME = privateHome.home;
      ctx.env.CLAUDE_CONFIG_DIR = privateHome.configDir;
      ctx.env.XDG_CONFIG_HOME = privateHome.xdgConfigHome;
      ctx.env.XDG_DATA_HOME = privateHome.xdgDataHome;
      applied.add(ctx.env);
      const evidence = Object.freeze({
        schema: "paperclip.subscription-auth-host-owned-final-env" as const,
        version: 1 as const,
        adapterType: "claude_local" as const,
      });
      preparedFinalEnvironments.set(evidence, { ...privateHome, token: tokenString });
      return evidence;
    },
    async dispose() {
      if (disposed) return;
      if (disposing) return disposing;
      disposing = (async () => {
        const expected = token.toString("utf8");
        for (const env of applied) {
          if (env[OAUTH_ENV_KEY] === expected) delete env[OAUTH_ENV_KEY];
          if (env.HOME === privateHome.home) delete env.HOME;
          if (env.CLAUDE_CONFIG_DIR === privateHome.configDir) delete env.CLAUDE_CONFIG_DIR;
          if (env.XDG_CONFIG_HOME === privateHome.xdgConfigHome) delete env.XDG_CONFIG_HOME;
          if (env.XDG_DATA_HOME === privateHome.xdgDataHome) delete env.XDG_DATA_HOME;
        }
        await fs.rm(privateHome.home, { recursive: true, force: true });
        applied.clear();
        token.fill(0);
        disposed = true;
      })();
      try {
        await disposing;
      } finally {
        if (!disposed) disposing = null;
      }
    },
  };
}

/**
 * Queue/run authority for Claude is intentionally narrower than the launch
 * preflight: only an exact, resolved fixed owner user-secret version is
 * immutable. Host/keychain login has no stable account or revision proof.
 */
export async function inspectClaudeSubscriptionAuthAuthority(
  input: SubscriptionAuthAuthorityInspectInput,
): Promise<SubscriptionAuthAuthorityInspection> {
  if (
    input.adapterType !== "claude_local" ||
    input.config.billingPolicy !== "subscription_only" ||
    input.config.engine !== "cli" ||
    !UUID_RE.test(input.companyId) ||
    !UUID_RE.test(input.agentId)
  ) {
    fail("Claude subscription auth authority requires a normalized local CLI subscription profile.");
  }
  if (input.authSource.kind === "native_host_login") {
    fail("Native Claude host login has no immutable account or credential revision authority.");
  }
  if (
    input.authSource.kind !== "resolved_user_secret_version" ||
    input.authSource.configPath !== OAUTH_CONFIG_PATH ||
    input.authSource.key !== OAUTH_ENV_KEY ||
    !UUID_RE.test(input.authSource.secretId) ||
    !UUID_RE.test(input.authSource.versionId) ||
    !Number.isSafeInteger(input.authSource.version) ||
    input.authSource.version <= 0 ||
    !input.authSource.value ||
    Buffer.byteLength(input.authSource.value, "utf8") > 64 * 1024
  ) {
    fail("Claude subscription auth authority requires the fixed OAuth user-secret at an exact version.");
  }

  const source = {
    secretId: input.authSource.secretId,
    versionId: input.authSource.versionId,
    version: input.authSource.version,
  };
  const token = Buffer.from(input.authSource.value, "utf8");
  let retainToken = false;
  const configEnv = record(input.config.env);
  if (configEnv[OAUTH_ENV_KEY] !== input.authSource.value || input.env[OAUTH_ENV_KEY] !== input.authSource.value) {
    token.fill(0);
    fail("Claude OAuth authority source does not match the final normalized environment.");
  }
  const policyFailure = classifySubscriptionOnlyProviderPolicy({
    adapterType: "claude_local",
    config: input.config,
    env: input.env,
    configuredEnv: configEnv,
  });
  if (policyFailure) {
    token.fill(0);
    throw new SubscriptionBillingPolicyFailure(
      policyFailure,
      "Claude subscription auth authority rejected the final provider environment.",
    );
  }

  const profileIdentityMaterial = encodeParts([
    "claude_oauth_user_secret",
    input.companyId,
    input.agentId,
    OAUTH_CONFIG_PATH,
    source.secretId,
  ]);
  const credentialRevisionMaterial = encodeParts([
    "claude_oauth_user_secret_version",
    source.secretId,
    source.versionId,
    String(source.version),
    token,
  ]);
  try {
    const [
      authProfileIdentity,
      authProfileRevision,
      accountIdentity,
      accountRevision,
      principalIdentity,
      principalRevision,
      credentialRevisionFingerprint,
    ] = await Promise.all([
      sign(input, "auth_profile_identity", profileIdentityMaterial),
      sign(input, "auth_profile_revision", credentialRevisionMaterial),
      sign(input, "account_identity", token),
      sign(input, "account_revision", credentialRevisionMaterial),
      sign(input, "principal_identity", token),
      sign(input, "principal_revision", credentialRevisionMaterial),
      sign(input, "credential_revision", credentialRevisionMaterial),
    ]);
    const evidence = (
      identityFingerprint: string,
      revisionFingerprint: string,
    ): SubscriptionAuthAuthorityEvidence => ({
      evidence: "credential_bound",
      identityFingerprint,
      revisionFingerprint,
    });
    const proof = {
      schema: SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
      version: SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
      adapterType: "claude_local" as const,
      companyId: input.companyId,
      agentId: input.agentId,
      authKind: "claude_oauth_user_secret" as const,
      sourceKind: "user_secret_version" as const,
      authProfile: evidence(authProfileIdentity, authProfileRevision),
      account: evidence(accountIdentity, accountRevision),
      principal: evidence(principalIdentity, principalRevision),
      credentialRevisionFingerprint,
    };
    if (input.mode === "prepare") {
      const privateHome = await createPrivateClaudeHome().catch(() =>
        fail("Claude subscription auth authority could not prepare private credential material."));
      retainToken = true;
      return { proof, prepared: makePreparedOAuth(token, privateHome) };
    }
    return { proof };
  } finally {
    profileIdentityMaterial.fill(0);
    credentialRevisionMaterial.fill(0);
    if (!retainToken) token.fill(0);
  }
}
