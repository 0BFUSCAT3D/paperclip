import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  type InspectSubscriptionAuthAuthority,
  type SubscriptionAuthAuthorityInspectInput,
  type SubscriptionAuthAuthorityProofV1,
} from "@paperclipai/adapter-utils";
import {
  EXECUTION_PROFILE_AUTH_AUTHORITY_SIGNING_DOMAIN,
  signExecutionProfileAuthAuthorityOpaque,
  withServerSubscriptionAuthAuthoritySigner,
} from "./execution-profile-auth-authority.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.unstubAllEnvs());

function fp(character: string) {
  return `decision-spec-v1.${character.repeat(64)}`;
}

function proof(): SubscriptionAuthAuthorityProofV1 {
  return {
    schema: SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
    version: SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
    adapterType: "claude_local",
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    authKind: "claude_oauth_user_secret",
    sourceKind: "user_secret_version",
    authProfile: { evidence: "credential_bound", identityFingerprint: fp("a"), revisionFingerprint: fp("b") },
    account: { evidence: "credential_bound", identityFingerprint: fp("c"), revisionFingerprint: fp("d") },
    principal: { evidence: "credential_bound", identityFingerprint: fp("e"), revisionFingerprint: fp("f") },
    credentialRevisionFingerprint: fp("0"),
  };
}

async function signedProof(input: SubscriptionAuthAuthorityInspectInput): Promise<SubscriptionAuthAuthorityProofV1> {
  const values = await Promise.all([
    input.signOpaque("auth_profile_identity", Buffer.from("profile-id")),
    input.signOpaque("auth_profile_revision", Buffer.from("profile-rev")),
    input.signOpaque("account_identity", Buffer.from("account-id")),
    input.signOpaque("account_revision", Buffer.from("account-rev")),
    input.signOpaque("principal_identity", Buffer.from("principal-id")),
    input.signOpaque("principal_revision", Buffer.from("principal-rev")),
    input.signOpaque("credential_revision", Buffer.from("credential-rev")),
  ]);
  return {
    ...proof(),
    authProfile: { evidence: "credential_bound", identityFingerprint: values[0], revisionFingerprint: values[1] },
    account: { evidence: "credential_bound", identityFingerprint: values[2], revisionFingerprint: values[3] },
    principal: { evidence: "credential_bound", identityFingerprint: values[4], revisionFingerprint: values[5] },
    credentialRevisionFingerprint: values[6],
  };
}

function request(mode: "inspect" | "prepare") {
  return {
    mode,
    adapterType: "claude_local",
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    config: {},
    env: {},
    authSource: { kind: "native_host_login", provider: "claude" } as const,
    signOpaque: () => fp("f"),
  };
}

describe("execution profile auth authority signer", () => {
  it("domain-separates opaque material with the stable server signing authority", async () => {
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "test-execution-profile-auth-authority-secret-value");
    const material = Buffer.from("same material");
    const account = await signExecutionProfileAuthAuthorityOpaque("account_identity", material);
    const principal = await signExecutionProfileAuthAuthorityOpaque("principal_identity", material);
    expect(account).toMatch(/^decision-spec-v1\.[a-f0-9]{64}$/);
    expect(principal).toMatch(/^decision-spec-v1\.[a-f0-9]{64}$/);
    expect(account).not.toBe(principal);
    expect(account).not.toContain(material.toString("utf8"));
    expect(EXECUTION_PROFILE_AUTH_AUTHORITY_SIGNING_DOMAIN).toBe("execution-profile-auth-authority/v1");
  });

  it("overrides the caller signer and rejects malformed mode results", async () => {
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "test-execution-profile-auth-authority-secret-value");
    const malicious = vi.fn(() => fp("f"));
    const implementation = vi.fn<InspectSubscriptionAuthAuthority>(async (input) => ({ proof: await signedProof(input) }));
    const wrapped = withServerSubscriptionAuthAuthoritySigner(implementation);
    const result = await wrapped({
      mode: "inspect",
      adapterType: "claude_local",
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      config: {},
      env: {},
      authSource: { kind: "native_host_login", provider: "claude" },
      signOpaque: malicious,
    });
    expect(malicious).not.toHaveBeenCalled();
    expect(result.proof.credentialRevisionFingerprint).not.toBe(fp("f"));

    const malformed = withServerSubscriptionAuthAuthoritySigner(async () => ({ proof: proof() }));
    await expect(malformed({
      mode: "prepare",
      adapterType: "claude_local",
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      config: {},
      env: {},
      authSource: { kind: "native_host_login", provider: "claude" },
      signOpaque: (_domain, bytes) => fp(createHash("sha256").update(bytes).digest("hex")[0] ?? "a"),
    })).rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
  });

  it.each(["inspect", "prepare"] as const)("rejects scope mismatches and disposes prepared material in %s mode", async (mode) => {
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "test-execution-profile-auth-authority-secret-value");
    for (const mismatch of ["adapterType", "companyId", "agentId"] as const) {
      const dispose = vi.fn(async () => undefined);
      const wrapped = withServerSubscriptionAuthAuthoritySigner(async (input) => {
        const base = await signedProof(input);
        const changed = mismatch === "adapterType"
          ? { ...base, adapterType: "codex_local" as const, authKind: "codex_chatgpt_managed_profile" as const, sourceKind: "managed_local_profile" as const,
              authProfile: { ...base.authProfile, evidence: "account_id_bound" as const }, account: { ...base.account, evidence: "account_id_bound" as const }, principal: { ...base.principal, evidence: "account_id_bound" as const } }
          : mismatch === "companyId"
            ? { ...base, companyId: "99999999-9999-4999-8999-999999999999" }
            : { ...base, agentId: "88888888-8888-4888-8888-888888888888" };
        return mode === "prepare"
          ? { proof: changed, prepared: { apply: async () => ({ schema: "paperclip.subscription-auth-host-owned-final-env", version: 1, adapterType: "claude_local" }), dispose } }
          : { proof: changed };
      });
      await expect(wrapped(request(mode))).rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
      expect(dispose).toHaveBeenCalledTimes(mode === "prepare" ? 1 : 0);
    }
  });

  it("rejects proof slots signed under the wrong domain and disposes", async () => {
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "test-execution-profile-auth-authority-secret-value");
    const dispose = vi.fn(async () => undefined);
    const wrapped = withServerSubscriptionAuthAuthoritySigner(async (input) => {
      const signed = await signedProof(input);
      return {
        proof: {
          ...signed,
          account: {
            ...signed.account,
            identityFingerprint: signed.principal.identityFingerprint,
          },
        },
        prepared: { apply: async () => ({ schema: "paperclip.subscription-auth-host-owned-final-env", version: 1, adapterType: "claude_local" }), dispose },
      };
    });
    await expect(wrapped(request("prepare"))).rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
