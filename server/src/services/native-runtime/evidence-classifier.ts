export interface NativeEvidenceAssessment {
  objectiveSatisfied: boolean;
  allCriteriaSatisfied: boolean;
  verificationPassed: boolean;
  hasBlockingRemainingWork: boolean;
  reportedDisposition: "done" | "blocked" | "needs_review" | "yielded";
  summary: string;
  blocker: { unblockAction: string; boardOwned: boolean } | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function classifyNativeEvidence(result: Record<string, unknown>): NativeEvidenceAssessment {
  const claim = record(result.completionClaim);
  const criteria = Array.isArray(claim.criteria) ? claim.criteria.map(record) : [];
  const remaining = Array.isArray(claim.remainingWork) ? claim.remainingWork.map(record) : [];
  const verification = Array.isArray(result.verification) ? result.verification.map(record) : [];
  const reported = result.reportedWorkDisposition;
  const blocker = record(result.blocker);
  const blockerOwner = record(blocker.owner);
  if (!["done", "blocked", "needs_review", "yielded"].includes(String(reported))) {
    throw new Error("native_result_invalid_disposition");
  }
  return {
    objectiveSatisfied: claim.objectiveSatisfied === true,
    allCriteriaSatisfied: criteria.length > 0 && criteria.every((criterion) => criterion.status === "satisfied"),
    verificationPassed: verification.length > 0 && verification.every((entry) => entry.status === "passed"),
    hasBlockingRemainingWork: remaining.some((entry) => entry.blocksCompletion === true),
    reportedDisposition: reported as NativeEvidenceAssessment["reportedDisposition"],
    summary: typeof result.summary === "string" ? result.summary : "Native run completed.",
    blocker: reported === "blocked" && typeof blocker.unblockAction === "string"
      ? {
          unblockAction: blocker.unblockAction,
          boardOwned: blockerOwner.kind === "board" || blockerOwner.owner === "board",
        }
      : null,
  };
}
