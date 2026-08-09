import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workAssessments } from "@paperclipai/db";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";
import { nativeSha256 } from "./canonical.js";

export async function recordNativeWorkAssessment(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  turnId: string | null;
  contractId: string;
  resultId: string;
  priorIssueStatus: string;
  priorStatusVersion: number;
  priorDecisionId: string | null;
  policyVersion: string;
  assessment: NativeEvidenceAssessment;
  supersedesAssessmentId?: string | null;
}) {
  const assessmentJson = input.assessment as unknown as Record<string, unknown>;
  const inputDigest = nativeSha256({
    contractId: input.contractId,
    resultId: input.resultId,
    priorIssueStatus: input.priorIssueStatus,
    priorStatusVersion: input.priorStatusVersion,
    policyVersion: input.policyVersion,
    assessment: assessmentJson,
  });
  const existing = await input.db.select().from(workAssessments).where(and(
    eq(workAssessments.resultId, input.resultId),
    eq(workAssessments.inputDigest, inputDigest),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (existing) return existing;
  const [row] = await input.db.insert(workAssessments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.runId,
    turnId: input.turnId,
    contractId: input.contractId,
    resultId: input.resultId,
    triggerKind: "native_result",
    triggerRef: input.resultId,
    triggerCapability: "server_native_finalizer",
    triggerActorCompanyId: input.companyId,
    priorIssueStatus: input.priorIssueStatus,
    priorStatusVersion: input.priorStatusVersion,
    priorDecisionId: input.priorDecisionId,
    policyVersion: input.policyVersion,
    assessmentJson,
    inputDigest,
    supersedesAssessmentId: input.supersedesAssessmentId ?? null,
  }).returning();
  if (!row) throw new Error("native_assessment_not_persisted");
  return row;
}
