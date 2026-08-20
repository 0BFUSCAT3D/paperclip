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
import { readSubscriptionAccountId } from "./codex-auth-cache.js";
import {
  readSecureCodexSubscriptionAuth,
  readSecureEffectiveCodexSubscriptionAuth,
  resolveManagedCodexHomeDir,
  validateManagedCodexHomePathAuthority,
  type SecureCodexSubscriptionAuthReadHooks,
} from "./codex-home.js";

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

async function zeroizeAndRemoveSnapshot(home: string): Promise<void> {
  const authPath = path.join(home, "auth.json");
  const stats = await fs.lstat(authPath).catch(() => null);
  if (stats?.isFile() && !stats.isSymbolicLink() && stats.size <= 64 * 1024) {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(authPath, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (opened.isFile() && opened.dev === stats.dev && opened.ino === stats.ino && opened.size <= 64 * 1024) {
        await handle.write(Buffer.alloc(Number(opened.size)), 0, Number(opened.size), 0);
        await handle.sync();
      }
    } catch {
      // Removal below is still required even when an attacker replaced the file.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  await fs.rm(home, { recursive: true, force: true });
}

type CodexPreparedFinalEnv = { home: string };
const preparedFinalEnvironments = new WeakMap<object, CodexPreparedFinalEnv>();

export function isCodexPreparedSubscriptionAuthFinalEnv(
  evidence: unknown,
  env: Record<string, string>,
): evidence is SubscriptionAuthHostOwnedFinalEnvEvidenceV1 {
  if (!evidence || typeof evidence !== "object") return false;
  const expected = preparedFinalEnvironments.get(evidence);
  return Boolean(expected && env.CODEX_HOME === expected.home);
}

function clearCodexHostAuthAndInjectionEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
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
      upper.startsWith("OPENAI_") ||
      upper.startsWith("CODEX_")
    ) {
      delete env[key];
    }
  }
}

async function repairPrivateSnapshot(input: {
  home: string;
  homeDev: number;
  homeIno: number;
  captured: Buffer;
}): Promise<number> {
  const homeStats = await fs.lstat(input.home).catch(() => null);
  if (
    !homeStats?.isDirectory() ||
    homeStats.isSymbolicLink() ||
    homeStats.dev !== input.homeDev ||
    homeStats.ino !== input.homeIno ||
    (process.platform !== "win32" && homeStats.uid !== process.getuid?.())
  ) {
    fail("Prepared Codex subscription authority private home is unverifiable.");
  }
  if (process.platform !== "win32" && (homeStats.mode & 0o077) !== 0) {
    await fs.chmod(input.home, 0o700);
  }

  const authPath = path.join(input.home, "auth.json");
  const existing = await fs.lstat(authPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isDirectory()) {
    fail("Prepared Codex subscription authority snapshot is unverifiable.");
  }
  const tempPath = path.join(input.home, `.auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(input.captured);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, authPath);
    const inspected = await readSecureCodexSubscriptionAuth(input.home);
    try {
      if (inspected.status !== "present" || !inspected.snapshot || !inspected.snapshot.equals(input.captured)) {
        fail("Prepared Codex subscription authority snapshot could not be verified.");
      }
    } finally {
      inspected.snapshot?.fill(0);
    }
    const finalStats = await fs.lstat(authPath);
    return finalStats.ino;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function makePreparedCodex(
  home: string,
  homeDev: number,
  homeIno: number,
  captured: Buffer,
): PreparedSubscriptionAuthAuthority {
  const applied = new Set<Record<string, string>>();
  let disposed = false;
  let disposing: Promise<void> | null = null;
  return {
    async apply(ctx) {
      if (disposed) fail("Prepared Codex subscription authority has been disposed.");
      await repairPrivateSnapshot({ home, homeDev, homeIno, captured });
      clearCodexHostAuthAndInjectionEnv(ctx.env);
      ctx.env.CODEX_HOME = home;
      applied.add(ctx.env);
      const evidence = Object.freeze({
        schema: "paperclip.subscription-auth-host-owned-final-env" as const,
        version: 1 as const,
        adapterType: "codex_local" as const,
      });
      preparedFinalEnvironments.set(evidence, { home });
      return evidence;
    },
    async dispose() {
      if (disposed) return;
      if (disposing) return disposing;
      disposing = (async () => {
        for (const env of applied) {
          if (env.CODEX_HOME === home) delete env.CODEX_HOME;
        }
        await zeroizeAndRemoveSnapshot(home);
        applied.clear();
        captured.fill(0);
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

async function createPrivateSnapshot(captured: Buffer): Promise<{ home: string; dev: number; ino: number }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-authority-"));
  try {
    await fs.chmod(home, 0o700);
    await fs.writeFile(path.join(home, "auth.json"), captured, { flag: "wx", mode: 0o600 });
    const stats = await fs.lstat(home);
    return { home, dev: stats.dev, ino: stats.ino };
  } catch (error) {
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Build opaque authority from one securely captured managed Codex auth file. */
export async function inspectCodexSubscriptionAuthAuthority(
  input: SubscriptionAuthAuthorityInspectInput,
  hooks: { authRead?: SecureCodexSubscriptionAuthReadHooks } = {},
): Promise<SubscriptionAuthAuthorityInspection> {
  if (
    input.adapterType !== "codex_local" ||
    input.config.billingPolicy !== "subscription_only" ||
    input.config.engine !== "cli" ||
    !UUID_RE.test(input.companyId) ||
    !UUID_RE.test(input.agentId)
  ) {
    fail("Codex subscription auth authority requires a normalized local CLI subscription profile.");
  }
  if (
    input.authSource.kind !== "managed_local_profile" ||
    input.authSource.profile !== "codex_agent_home" ||
    !input.authSource.location
  ) {
    fail("Codex subscription auth authority requires the current agent managed profile.");
  }
  const canonicalHome = resolveManagedCodexHomeDir(process.env, input.companyId, input.agentId);
  const sourceHome = path.resolve(input.authSource.location);
  if (sourceHome !== canonicalHome) {
    fail("Codex subscription auth authority source is not the current agent managed profile.");
  }
  const pathAuthority = await validateManagedCodexHomePathAuthority(
    process.env,
    input.companyId,
    input.agentId,
    sourceHome,
  );
  if (!pathAuthority) {
    fail("Codex subscription auth authority managed profile ancestry is unverifiable.");
  }
  const configEnv = record(input.config.env);
  for (const configuredHome of [configEnv.CODEX_HOME, input.env.CODEX_HOME]) {
    if (typeof configuredHome === "string" && configuredHome.trim() && path.resolve(configuredHome) !== sourceHome) {
      fail("Codex subscription auth authority source does not match the final normalized environment.");
    }
  }
  const policyFailure = classifySubscriptionOnlyProviderPolicy({
    adapterType: "codex_local",
    config: input.config,
    env: input.env,
    configuredEnv: configEnv,
  });
  if (policyFailure) {
    throw new SubscriptionBillingPolicyFailure(
      policyFailure,
      "Codex subscription auth authority rejected the final provider environment.",
    );
  }

  const inspected = await readSecureEffectiveCodexSubscriptionAuth(sourceHome, process.env, hooks.authRead);
  if (inspected.status === "metered") {
    throw new SubscriptionBillingPolicyFailure(
      "metered_credential_present",
      "Codex subscription auth authority rejected metered credentials.",
    );
  }
  if (inspected.status !== "present" || !inspected.snapshot) {
    fail("Codex subscription auth authority could not securely capture ChatGPT authentication.");
  }
  const captured = inspected.snapshot;
  if (!await validateManagedCodexHomePathAuthority(
    process.env,
    input.companyId,
    input.agentId,
    sourceHome,
    pathAuthority,
  )) {
    captured.fill(0);
    fail("Codex subscription auth authority managed profile ancestry changed during inspection.");
  }
  const accountId = readSubscriptionAccountId(captured);
  if (!accountId) {
    captured.fill(0);
    fail("Codex subscription auth authority could not prove a ChatGPT account identity.");
  }
  const profileIdentityMaterial = encodeParts([
    "codex_agent_home",
    input.companyId,
    input.agentId,
  ]);
  const accountIdentityMaterial = Buffer.from(accountId, "utf8");
  let retainCaptured = false;
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
      sign(input, "auth_profile_revision", captured),
      sign(input, "account_identity", accountIdentityMaterial),
      sign(input, "account_revision", captured),
      sign(input, "principal_identity", accountIdentityMaterial),
      sign(input, "principal_revision", captured),
      sign(input, "credential_revision", captured),
    ]);
    const evidence = (
      identityFingerprint: string,
      revisionFingerprint: string,
    ): SubscriptionAuthAuthorityEvidence => ({
      evidence: "account_id_bound",
      identityFingerprint,
      revisionFingerprint,
    });
    const proof = {
      schema: SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
      version: SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
      adapterType: "codex_local" as const,
      companyId: input.companyId,
      agentId: input.agentId,
      authKind: "codex_chatgpt_managed_profile" as const,
      sourceKind: "managed_local_profile" as const,
      authProfile: evidence(authProfileIdentity, authProfileRevision),
      account: evidence(accountIdentity, accountRevision),
      principal: evidence(principalIdentity, principalRevision),
      credentialRevisionFingerprint,
    };
    if (input.mode === "prepare") {
      const snapshot = await createPrivateSnapshot(captured).catch(() =>
        fail("Codex subscription auth authority could not prepare private credential material."));
      retainCaptured = true;
      return { proof, prepared: makePreparedCodex(snapshot.home, snapshot.dev, snapshot.ino, captured) };
    }
    return { proof };
  } finally {
    profileIdentityMaterial.fill(0);
    accountIdentityMaterial.fill(0);
    if (!retainCaptured) captured.fill(0);
  }
}
