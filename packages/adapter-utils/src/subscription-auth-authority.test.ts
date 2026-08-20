import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  isSubscriptionAuthAuthorityInspectionForMode,
  isSubscriptionAuthAuthorityProof,
  type SubscriptionAuthAuthorityProofV1,
} from "./subscription-auth-authority.js";

const fp = (character: string) => `decision-spec-v1.${character.repeat(64)}`;
const proof: SubscriptionAuthAuthorityProofV1 = {
  schema: SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  version: SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  adapterType: "claude_local",
  companyId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  authKind: "claude_oauth_user_secret",
  sourceKind: "user_secret_version",
  authProfile: { evidence: "credential_bound", identityFingerprint: fp("a"), revisionFingerprint: fp("b") },
  account: { evidence: "credential_bound", identityFingerprint: fp("c"), revisionFingerprint: fp("d") },
  principal: { evidence: "credential_bound", identityFingerprint: fp("e"), revisionFingerprint: fp("f") },
  credentialRevisionFingerprint: fp("0"),
};

describe("subscription auth authority proof", () => {
  it("accepts the exact versioned safe proof shape", () => {
    expect(isSubscriptionAuthAuthorityProof(proof)).toBe(true);
  });

  it("rejects missing, unknown-version, and incomplete evidence", () => {
    expect(isSubscriptionAuthAuthorityProof(null)).toBe(false);
    expect(isSubscriptionAuthAuthorityProof({ ...proof, version: 2 })).toBe(false);
    expect(isSubscriptionAuthAuthorityProof({ ...proof, account: { evidence: "credential_bound" } })).toBe(false);
  });

  it("rejects unknown keys, cross-paired kinds, invalid UUIDs, and oversized fingerprints", () => {
    expect(isSubscriptionAuthAuthorityProof({ ...proof, unknown: true })).toBe(false);
    expect(isSubscriptionAuthAuthorityProof({
      ...proof,
      adapterType: "codex_local",
      authKind: "claude_oauth_user_secret",
      sourceKind: "user_secret_version",
    })).toBe(false);
    expect(isSubscriptionAuthAuthorityProof({ ...proof, companyId: "" })).toBe(false);
    expect(isSubscriptionAuthAuthorityProof({ ...proof, credentialRevisionFingerprint: "" })).toBe(false);
    expect(isSubscriptionAuthAuthorityProof({ ...proof, credentialRevisionFingerprint: fp("a") + "a" })).toBe(false);
    expect(isSubscriptionAuthAuthorityProof({
      ...proof,
      account: { ...proof.account, unknown: "field" },
    })).toBe(false);
  });

  it("requires inspect to omit prepared and prepare to include the closed lifecycle", () => {
    const prepared = { apply: async () => {}, dispose: async () => {} };
    expect(isSubscriptionAuthAuthorityInspectionForMode({ proof }, "inspect")).toBe(true);
    expect(isSubscriptionAuthAuthorityInspectionForMode({ proof, prepared }, "inspect")).toBe(false);
    expect(isSubscriptionAuthAuthorityInspectionForMode({ proof }, "prepare")).toBe(false);
    expect(isSubscriptionAuthAuthorityInspectionForMode({ proof, prepared }, "prepare")).toBe(true);
  });
});
