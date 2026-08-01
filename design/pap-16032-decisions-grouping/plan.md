# Decisions: grouping, queues, and a "today's desk" — plan (rev 1)

**Wireframes:** https://pages.paperclip.ing/pap-16032-decisions-desk/ (4 screens + flow, with the data analysis inline)

## 1. Problem

[/PAP/decisions](/PAP/decisions) shows every pending decision for the whole company in one uncapped list, newest activity first. It answers "what exists", never "what do I need to decide today, in what order". Items accumulate forever because most feed sources have no retirement path.

## 2. What the data says (live dev company, 2026-08-01)

| Signal | Value | Implication |
| --- | --- | --- |
| Open in-review items | 290 | Nobody can decide 290 things; the list is write-only |
| Touched today / yesterday / this week | 8 / 12 / 24 | The real daily load is small — a "today's desk" is viable |
| Idle > 30 days | 146 (oldest: April) | Retirement matters more than any sorting tweak |
| Priority = "medium" | 261 of 290 | Issue priority is dead as a ranking signal; importance must be assigned at decision time |
| Title-based clustering | 57% land in "other" | Type/queue must be first-class metadata, not title heuristics |

**Common threads in recent decisions** (interaction titles + origin pipelines): *Merge this PR* (gardener/land-my-features confirmations, CI-green, batchable) · *Approve this plan revision* (planning-mode confirmations bound to a plan doc rev) · *Verify/accept QA result* · *Answer questions* (ask_user_questions forms) · *Pick a subset* (checkbox confirmations).

## 3. Current mechanics (verified in code)

- The page is `WhatNeedsMe.tsx` over `GET /companies/:id/attention` (`server/src/services/attention.ts`), aggregating 11 source kinds (approvals, issue-thread interactions, decisions v1, reviews = in_review issues, blockers, failed runs, …). Only query knob: `includeDismissed`. No pagination, no server-side filters.
- Grouping/sort/filter are entirely client-side (`ui/src/lib/attention.ts`): group by none/date/type/project/severity with fixed buckets (Today/Yesterday/This week/Earlier). **No date-range picker.** Sort: newest/oldest only.
- **No queue/tag/category column** on `decisions`, `issue_thread_interactions`, or `approvals`. The only hooks: `decisions.rule_key` (free text, set by proposing agent, rendered nowhere) and `decision_bundles` (groups one agent run, not a durable stream). `labels` exist but are issue-scoped only.
- The feed item DTO drops `expiresAt`, `ruleKey`, priority, and origin-agent name — the UI couldn't rank or group by them today even client-side.
- Decisions v1 has TTL + sweeper; interactions expire; but `approvals` and `review` (in_review issues) never retire — they are the accumulation vector (the 290).
- Sidebar badge = total feed length (290 = noise). `?decisionId=` deep links are generated but never consumed by the page. `GET /decisions/stats?groupBy=ruleKey` exists server-side, unused by UI.

## 4. Design

### 4.1 Queues — the general rule for quicklinks

A **queue** is a named, company-scoped, durable list of decisions. Answering Dotta's "not everyone has PRs" question: quicklinks are **not** hardcoded types — they are **this company's queues, ordered by most recently updated**. "PRs" exists because the gardener feeds it; another company's rail might say "invoices" or "content".

- New `decision_queues` table (id, company_id, key, title, description, created_by_agent_id/user_id, retention_days override, updated_at).
- New `decision_queue_items` side-car (queue_id, source_kind, source_id, added_by, created_at) keyed on the attention item's stable identity — so **any** of the 11 source kinds can be queued without touching 11 tables (same pattern as `decision_training_examples`).
- **Seeding** so the rail is never empty: system rules map structural signals → starter queues: merge confirmations / `pull_request` work products → "PRs"; plan-document-bound confirmations → "Plans"; `ask_user_questions` → "Questions". Seed rules are visible in the queue's rules card and can be disabled.
- **Agent/user write path**: `POST /api/companies/:cid/decision-queues` and `POST .../decision-queues/:key/items` (agent-authorized), so "add this to the foobar queue" works from any agent conversation. Queue pages support bulk accept/reject over homogeneous items with per-item exclusion reasons.

### 4.2 Date ranges

Chip row on the desk: Today / Yesterday / Last 7 days / This month / Custom range, filtering on `activityAt`. Server side: add `activitySince`/`activityUntil` + cursor pagination to `/attention` so the desk stops shipping 290 items to the client on every badge poll.

### 4.3 Today's desk — importance ordering

Default landing view = today's items split into **Decide now / Can wait**, ordered by a per-item **decide-by** field (`today | this_week | whenever | date`), settable by agents via API and overridable by the user (provenance shown: "Set by Prioritizer"). Ranking: decide_by → expiry proximity → severity → activityAt. The feed DTO gains `expiresAt`, `ruleKey`, `originAgentName`, `queues[]`, `decideBy`. Sidebar badge becomes the **decide-now count** (open question 1). Fix the `?decisionId=` deep link to focus/expand the referenced card.

### 4.4 Retirement — the aging shelf

Uniform staleness across all feed sources: items idle > 30 days (per-queue override) leave the desk for an **aging shelf**; idle > 90 days auto-archive unless marked Keep. Archiving never deletes — items stay searchable and revivable — and notifies the origin agent so the underlying task is re-triaged, not orphaned. Agents can submit **bulk archive proposals** with per-item reasoning (dogfoods decisions v1 propose-mode); the shelf renders the proposal as one accept gesture.

### 4.5 Agent triage affordances

Every card gets a triage strip (queue picker, decide-by control, snooze, route-to-agent). The same operations exposed as agent APIs + documented in the paperclip skill, so "agents alongside helping us tag and prioritize" have first-class writes — always rendered as attributed suggestions/settings, never silent mutations.

## 5. Phasing (children created after plan acceptance)

| Phase | Scope | Owner | Depends on |
| --- | --- | --- | --- |
| P0 | SecurityEngineer review: queue/triage write authz (agents writing cross-issue), archive-notify path | SecurityEngineer | — |
| P1 | Schema + queue/triage APIs (`decision_queues`, `decision_queue_items`, decide_by storage, seed rules) | CodexCoder | P0 |
| P2 | Attention feed enrichment: DTO fields, `activitySince/Until`, pagination, decide-now ordering, badge count | CodexCoder | P1 |
| P3 | UI: today's desk, queue rail + queue page w/ bulk actions, triage strip, aging shelf, deep-link fix (screenshots required) | ClaudeCoder + UXDesigner review | P1, P2 |
| P4 | Agent enablement: skill docs, "add to queue"/"set decide-by" recipes, gardener wires rule_key → PRs queue | CodexCoder | P1 |
| P5 | Retention: staleness computation, auto-archive sweeper, origin-agent notify, bulk archive proposals | CodexCoder | P1, P2 |
| P6 | QA end-to-end vs acceptance criteria + live screenshots | QA | P3, P4, P5 |

## 6. Open questions (also on the wireframe page)

1. **Badge semantics** — decide-now count (proposed) vs total pending?
2. **Auto-archive consent** — 90-day auto-archive as default, or always via accepted agent proposal?
3. **Queue scope** — company-wide (proposed) vs per-user?
4. **Seeded queues** — OK to auto-seed PRs / Plans / Questions?
5. **Mobile** — desktop-first here; phone pass after structure is agreed?

## 7. Acceptance criteria for the epic

- Landing on /PAP/decisions shows today's decisions ordered by decide-by/importance, not 290 items.
- A queue created by telling an agent "add this to the foobar queue" appears as a quicklink chip within one feed refresh.
- Date chips + custom range filter server-side; the badge reflects decide-now count only.
- Items idle 30+ days are absent from the default desk and present on the aging shelf; bulk archive works and notifies origin agents.
- All new write paths pass SecurityEngineer review; QA e2e green with screenshots.
