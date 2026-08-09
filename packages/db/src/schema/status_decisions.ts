import { pgTable, uuid, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { workAssessments } from "./work_assessments.js";

export const statusDecisions = pgTable("status_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  assessmentId: uuid("assessment_id").notNull().references(() => workAssessments.id),
  decisionVersion: integer("decision_version").notNull(),
  policyVersion: text("policy_version").notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  reasonCode: text("reason_code").notNull(),
  decisionJson: jsonb("decision_json").$type<Record<string, unknown>>().notNull(),
  decisionDigest: text("decision_digest").notNull(),
  applicationState: text("application_state").notNull().default("pending"),
  supersedesDecisionId: uuid("supersedes_decision_id"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  assessmentVersionUq: uniqueIndex("status_decisions_assessment_version_uq").on(table.assessmentId, table.decisionVersion),
  issueDigestUq: uniqueIndex("status_decisions_issue_digest_uq").on(table.issueId, table.decisionDigest),
}));
