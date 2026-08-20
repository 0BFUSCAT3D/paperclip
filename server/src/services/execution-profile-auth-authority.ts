import {
  SubscriptionBillingPolicyFailure,
  SUBSCRIPTION_AUTH_AUTHORITY_OPAQUE_DOMAINS,
  isSubscriptionAuthAuthorityInspectionForMode,
  type InspectSubscriptionAuthAuthority,
  type SubscriptionAuthAuthorityOpaqueDomain,
  type SubscriptionAuthAuthoritySignOpaque,
} from "@paperclipai/adapter-utils";
import { signDecisionSpec } from "./decision-signing.js";

export const EXECUTION_PROFILE_AUTH_AUTHORITY_SIGNING_DOMAIN =
  "execution-profile-auth-authority/v1" as const;

/** Server-owned signer. Raw material is transient input to the existing instance HMAC. */
export const signExecutionProfileAuthAuthorityOpaque: SubscriptionAuthAuthoritySignOpaque = (
  opaqueDomain: SubscriptionAuthAuthorityOpaqueDomain,
  material: Uint8Array,
) => signDecisionSpec({
  domain: EXECUTION_PROFILE_AUTH_AUTHORITY_SIGNING_DOMAIN,
  opaqueDomain,
  encoding: "base64",
  material: Buffer.from(material).toString("base64"),
});

/**
 * Bind an adapter implementation to the server signer and validate the closed
 * proof/lifecycle result before it can cross into durable server code.
 */
export function withServerSubscriptionAuthAuthoritySigner(
  inspect: InspectSubscriptionAuthAuthority,
): InspectSubscriptionAuthAuthority {
  return async (input) => {
    const signedByDomain = new Map<SubscriptionAuthAuthorityOpaqueDomain, string[]>();
    const result = await inspect({
      ...input,
      // Never trust or forward a caller-provided signer through the registry.
      signOpaque: async (domain, material) => {
        const signed = await signExecutionProfileAuthAuthorityOpaque(domain, material);
        const outputs = signedByDomain.get(domain) ?? [];
        outputs.push(signed);
        signedByDomain.set(domain, outputs);
        return signed;
      },
    });
    const possiblePrepared = result && typeof result === "object"
      ? (result as unknown as { prepared?: unknown }).prepared
      : undefined;
    const disposePrepared = possiblePrepared
      && typeof possiblePrepared === "object"
      && typeof (possiblePrepared as { dispose?: unknown }).dispose === "function"
      ? () => (possiblePrepared as { dispose(): Promise<void> }).dispose()
      : null;
    const disposeAndFail = async (): Promise<never> => {
      await disposePrepared?.().catch(() => undefined);
      throw new SubscriptionBillingPolicyFailure(
        "subscription_auth_unverifiable",
        "Adapter returned malformed subscription auth authority evidence.",
      );
    };
    if (!isSubscriptionAuthAuthorityInspectionForMode(result, input.mode)) {
      return disposeAndFail();
    }
    const proof = result.proof;
    if (
      proof.adapterType !== input.adapterType ||
      proof.companyId !== input.companyId ||
      proof.agentId !== input.agentId
    ) return disposeAndFail();

    const expectedSlots: Record<SubscriptionAuthAuthorityOpaqueDomain, string> = {
      auth_profile_identity: proof.authProfile.identityFingerprint,
      auth_profile_revision: proof.authProfile.revisionFingerprint,
      account_identity: proof.account.identityFingerprint,
      account_revision: proof.account.revisionFingerprint,
      principal_identity: proof.principal.identityFingerprint,
      principal_revision: proof.principal.revisionFingerprint,
      credential_revision: proof.credentialRevisionFingerprint,
    };
    const domainsMatch = SUBSCRIPTION_AUTH_AUTHORITY_OPAQUE_DOMAINS.every((domain) => {
      const outputs = signedByDomain.get(domain);
      return outputs?.length === 1 && outputs[0] === expectedSlots[domain];
    }) && signedByDomain.size === SUBSCRIPTION_AUTH_AUTHORITY_OPAQUE_DOMAINS.length;
    if (!domainsMatch) return disposeAndFail();
    return result;
  };
}
