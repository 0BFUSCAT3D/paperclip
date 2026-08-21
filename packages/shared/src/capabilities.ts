export const PAPERCLIP_CAPABILITIES_API_PATH = "/api/capabilities" as const;
export const PAPERCLIP_CAPABILITIES_CONTRACT_VERSION = 1 as const;

/** Phase-2 descriptor. Do not add this to the live capability response until its routes are mounted. */
export const ARTIFACT_BOUND_DIRECTOR_SHIP_CAPABILITY_V1 = {
  supported: true,
  version: 1,
  artifactKind: "github_pull_request",
  candidateEndpoint: "/api/v1/issues/{issueId}/artifact-director-ship-candidate",
  confirmationEndpoint: "/api/v1/issues/{issueId}/artifact-director-ships/{idempotencyKey}",
  lookupEndpoint: "/api/v1/issues/{issueId}/artifact-director-ships/{idempotencyKey}",
  confirmationMethod: "PUT",
  mergeMethod: "merge",
  exactHeadCas: true,
  durableIntentBeforeMerge: true,
  crossSystemReconciliation: true,
  preIntentMergedReceiptForbidden: true,
  genericFinalApprovalQuarantined: true,
  durableCompletionReceipt: true,
} as const;

export interface PaperclipCapabilitiesResponseV1 {
  contractVersion: typeof PAPERCLIP_CAPABILITIES_CONTRACT_VERSION;
  features: {
    artifactBoundExecutionReviewEvidence: {
      supported: true;
      version: 1;
      artifactKind: "github_pull_request";
      endpoint: "/api/issues/{issueId}/execution-review-evidence";
      bindsExactHeadRevision: true;
    };
    artifactBoundDirectorShip: typeof ARTIFACT_BOUND_DIRECTOR_SHIP_CAPABILITY_V1;
    executionPolicyParticipantValidation: {
      supported: true;
      version: 1;
      atomic: true;
      companyScoped: true;
      activeAgentRequired: true;
      participantAgentInvokableRequired: true;
      invokableAgentStatuses: readonly ["active", "idle", "running", "error"];
      governedAssigneeInvokableRequired: true;
      typedUserMembershipRequired: true;
      independentNotCreatorReviewRequired: true;
      createIdempotencyLookupEndpoint: "/api/companies/{companyId}/issues/by-create-idempotency-key/{encodedKey}";
    };
    governedIssueReservationActivation: {
      supported: true;
      version: 2;
      reservationEndpoint: "/api/v2/companies/{companyId}/governed-issue-reservations";
      reservationLookupEndpoint: "/api/v2/companies/{companyId}/governed-issue-reservations/{encodedKey}";
      activationEndpoint: "/api/v2/companies/{companyId}/governed-issue-reservations/{encodedKey}/activation";
      reservationMethod: "POST";
      activationMethod: "PUT";
      reservationStatus: "backlog";
      reservationUnassigned: true;
      exactEnvelopeCas: true;
      durableWakeReceipt: true;
      participantExecutionProfileRevisionCas: true;
      immutableRunExecutionProfileReceipt: true;
      exactSubscriptionAuthAuthority: true;
      preSpawnAuthorityPreparation: true;
      billingPolicy: "subscription_only";
      claudeAuthAuthority: "owner_secret_version";
      codexAuthAuthority: "managed_chatgpt_profile";
      nativeHostClaudeLoginAccepted: false;
    };
    executionAuditAgentDeleteProtection: {
      supported: true;
      version: 1;
      nonterminalPolicyAndStateReferencesProtected: true;
      nonterminalGovernedAssigneeProtected: true;
      durableDecisionEvidenceProtected: true;
      artifactBuilderProvenanceProtected: true;
    };
  };
}

export const PAPERCLIP_CAPABILITIES_V1: PaperclipCapabilitiesResponseV1 = {
  contractVersion: PAPERCLIP_CAPABILITIES_CONTRACT_VERSION,
  features: {
    artifactBoundExecutionReviewEvidence: {
      supported: true,
      version: 1,
      artifactKind: "github_pull_request",
      endpoint: "/api/issues/{issueId}/execution-review-evidence",
      bindsExactHeadRevision: true,
    },
    artifactBoundDirectorShip: ARTIFACT_BOUND_DIRECTOR_SHIP_CAPABILITY_V1,
    executionPolicyParticipantValidation: {
      supported: true,
      version: 1,
      atomic: true,
      companyScoped: true,
      activeAgentRequired: true,
      participantAgentInvokableRequired: true,
      invokableAgentStatuses: ["active", "idle", "running", "error"],
      governedAssigneeInvokableRequired: true,
      typedUserMembershipRequired: true,
      independentNotCreatorReviewRequired: true,
      createIdempotencyLookupEndpoint: "/api/companies/{companyId}/issues/by-create-idempotency-key/{encodedKey}",
    },
    governedIssueReservationActivation: {
      supported: true,
      version: 2,
      reservationEndpoint: "/api/v2/companies/{companyId}/governed-issue-reservations",
      reservationLookupEndpoint: "/api/v2/companies/{companyId}/governed-issue-reservations/{encodedKey}",
      activationEndpoint: "/api/v2/companies/{companyId}/governed-issue-reservations/{encodedKey}/activation",
      reservationMethod: "POST",
      activationMethod: "PUT",
      reservationStatus: "backlog",
      reservationUnassigned: true,
      exactEnvelopeCas: true,
      durableWakeReceipt: true,
      participantExecutionProfileRevisionCas: true,
      immutableRunExecutionProfileReceipt: true,
      exactSubscriptionAuthAuthority: true,
      preSpawnAuthorityPreparation: true,
      billingPolicy: "subscription_only",
      claudeAuthAuthority: "owner_secret_version",
      codexAuthAuthority: "managed_chatgpt_profile",
      nativeHostClaudeLoginAccepted: false,
    },
    executionAuditAgentDeleteProtection: {
      supported: true,
      version: 1,
      nonterminalPolicyAndStateReferencesProtected: true,
      nonterminalGovernedAssigneeProtected: true,
      durableDecisionEvidenceProtected: true,
      artifactBuilderProvenanceProtected: true,
    },
  },
};
