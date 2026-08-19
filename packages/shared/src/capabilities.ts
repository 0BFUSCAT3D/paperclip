export const PAPERCLIP_CAPABILITIES_API_PATH = "/api/capabilities" as const;
export const PAPERCLIP_CAPABILITIES_CONTRACT_VERSION = 1 as const;

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
      version: 1;
      reservationEndpoint: "/api/v1/companies/{companyId}/governed-issue-reservations";
      reservationLookupEndpoint: "/api/v1/companies/{companyId}/governed-issue-reservations/{encodedKey}";
      activationEndpoint: "/api/v1/companies/{companyId}/governed-issue-reservations/{encodedKey}/activation";
      reservationMethod: "POST";
      activationMethod: "PUT";
      reservationStatus: "backlog";
      reservationUnassigned: true;
      exactEnvelopeCas: true;
      durableWakeReceipt: true;
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
      version: 1,
      reservationEndpoint: "/api/v1/companies/{companyId}/governed-issue-reservations",
      reservationLookupEndpoint: "/api/v1/companies/{companyId}/governed-issue-reservations/{encodedKey}",
      activationEndpoint: "/api/v1/companies/{companyId}/governed-issue-reservations/{encodedKey}/activation",
      reservationMethod: "POST",
      activationMethod: "PUT",
      reservationStatus: "backlog",
      reservationUnassigned: true,
      exactEnvelopeCas: true,
      durableWakeReceipt: true,
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
