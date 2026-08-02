/**
 * Synthetic fixtures for the Task Chat Redesign dev harness. No live agent is
 * required: every state in the inventory maps to a deterministic scenario the
 * harness renders and the finish-line test iterates. Tier-B states are driven
 * entirely from here (live protocol wiring is a flagged dependency).
 */
import type { TaskChatItem, TaskChatPlan } from "./task-chat-model";
import type { TaskChatStateId } from "./task-chat-states";

export interface TaskChatScenario {
  surface: "thread" | "plan";
  items: TaskChatItem[];
  plan?: TaskChatPlan;
}

const AGENT = "Atlas";

/** A short human→agent exchange used as context in several scenarios. */
function exchangePrefix(): TaskChatItem[] {
  return [
    { id: "m-user-1", kind: "message", author: "human", text: "Add a rate limiter to the login route.", timestamp: "2:31 PM" },
  ];
}

const SAMPLE_PLAN: TaskChatPlan = {
  revision: 2,
  updatedAt: "2:33 PM",
  entries: [
    { id: "p1", content: "Read the login route and existing middleware", status: "completed", priority: "medium" },
    { id: "p2", content: "Add a token-bucket rate limiter util", status: "in_progress", priority: "high" },
    { id: "p3", content: "Wire the limiter into POST /login", status: "pending", priority: "high" },
    { id: "p4", content: "Add tests for the limit + reset window", status: "pending", priority: "low" },
  ],
};

export function buildScenario(id: TaskChatStateId): TaskChatScenario {
  switch (id) {
    case "session-start":
      return {
        surface: "thread",
        items: [
          { id: "mk-start", kind: "marker", variant: "session_start", label: "Session started", detail: "claude · Agent mode" },
          ...exchangePrefix(),
        ],
      };
    case "human-message":
      return { surface: "thread", items: exchangePrefix() };
    case "agent-message":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          { id: "m-agent-1", kind: "message", author: "agent", authorName: AGENT, agentIcon: "bot", modeLabel: "Agent mode", text: "On it — I'll add a token-bucket limiter and wire it into the login route.", timestamp: "2:31 PM" },
        ],
      };
    case "thinking":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          { id: "th-1", kind: "thinking", streaming: true, lines: ["The login route is in server/src/routes/auth.ts.", "There's already an ipRateLimit helper I can reuse.", "I'll add a per-account bucket keyed on the email."] },
        ],
      };
    case "responding":
      // Streaming self-talk takes the parent row's line (PAP-356): it types in
      // where the gerund sat, wraps into the 1lh viewport line-scroll, and the
      // already-finished interstitial nests below like a completed tool row.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-responding",
            kind: "turn",
            settled: false,
            summary: { toolCount: 1, added: 0, removed: 0 },
            liveStatus: {
              id: "st-responding", kind: "status", status: "running", label: "Responding", startedAtMs: Date.now() - 9300,
              selfTalk:
                "I found an existing ipRateLimit helper, so I'll extend it with a per-account token bucket keyed on the email address instead of adding a second limiter. The bucket refills at six requests a minute, matching the lockout policy the auth spec documents, and failed attempts drain it twice as fast so brute-force runs hit the ceiling quickly while a fat-fingered password barely registers.",
            },
            items: [
              { id: "resp-note", kind: "message", author: "agent", authorName: AGENT, interstitial: true, text: "The login route already imports `ipRateLimit`, so I can reuse its sliding-window store instead of adding a dependency." },
              { id: "resp-read", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
            ],
          },
        ],
      };
    case "tool-call":
      return {
        surface: "thread",
        items: [
          { id: "tool-1", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "in_progress" },
        ],
      };
    case "diff":
      return {
        surface: "thread",
        items: [
          {
            id: "tool-diff", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "completed", decision: "allowed",
            diff: {
              path: "server/src/routes/auth.ts", added: 3, removed: 1,
              lines: [
                { kind: "context", text: "router.post('/login', async (req, res) => {" },
                { kind: "remove", text: "  const ok = await checkPassword(req.body);" },
                { kind: "add", text: "  await rateLimiter.consume(req.body.email);" },
                { kind: "add", text: "  const ok = await checkPassword(req.body);" },
                { kind: "add", text: "  if (!ok) return res.status(401).end();" },
              ],
            },
          },
        ],
      };
    case "working":
      // Parent-row live turn (PAP-354): the tool-state line owns the activity;
      // expanding nests the chronological history underneath.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-working",
            kind: "turn",
            settled: false,
            summary: { toolCount: 2, added: 0, removed: 0 },
            liveStatus: { id: "st-working", kind: "status", status: "working", label: "Editing files", detail: "Edit · server/src/routes/auth.ts", toolName: "Edit", startedAtMs: Date.now() - 4200 },
            items: [
              { id: "w-read", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
              { id: "w-edit", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "in_progress" },
            ],
          },
        ],
      };
    case "running":
      // Generic label → the parent row header rotates whimsical gerunds.
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-running",
            kind: "turn",
            settled: false,
            summary: { toolCount: 1, added: 0, removed: 0 },
            liveStatus: { id: "st-running", kind: "status", status: "running", label: "Running", detail: "no output for 3s — still running", startedAtMs: Date.now() - 12000, tokens: { used: 18240, size: 200000 } },
            items: [
              { id: "r-think", kind: "thinking", lines: ["The login route is in server/src/routes/auth.ts.", "Check for an existing limiter before writing one."] },
              { id: "r-grep", kind: "tool", name: "Grep", target: "rateLimit", toolKind: "search", status: "completed" },
            ],
          },
        ],
      };
    case "completed":
      return {
        surface: "thread",
        items: [
          ...exchangePrefix(),
          {
            id: "turn-done",
            kind: "turn",
            settled: true,
            summary: { durationLabel: "38s", toolCount: 3, added: 34, removed: 3, tokensLabel: "12.3k tokens" },
            items: [
              { id: "th-done", kind: "thinking", lines: ["Read auth.ts", "Added rate-limiter util", "Wired into POST /login"] },
              { id: "tool-done-1", kind: "tool", name: "Read", target: "server/src/routes/auth.ts", toolKind: "read", status: "completed" },
              // Settled self-talk nests with the tool rows (accepted §5.4).
              { id: "m-done-note", kind: "message", author: "agent", authorName: AGENT, interstitial: true, text: "Reusing the `ipRateLimit` store — adding a per-account bucket beside it." },
              { id: "tool-done-2", kind: "tool", name: "Edit", target: "server/src/routes/auth.ts", toolKind: "edit", status: "completed", diff: { path: "server/src/routes/auth.ts", added: 34, removed: 3 } },
            ],
          },
          { id: "m-done", kind: "message", author: "agent", authorName: AGENT, agentIcon: "bot", modeLabel: "Agent mode", text: "Done — added a per-account token-bucket limiter and wired it into the login route. Tests pass.", timestamp: "2:34 PM" },
        ],
      };
    case "awaiting-approval":
      return {
        surface: "thread",
        items: [
          {
            id: "st-approval", kind: "status", status: "awaiting_approval", label: "Approve running a command?",
            detail: "npm run migrate — modifies the database",
            approval: {
              toolName: "execute",
              options: [
                { id: "reject", label: "Deny", kind: "reject_once" },
                { id: "allow-always", label: "Always allow", kind: "allow_always" },
                { id: "allow", label: "Allow once", kind: "allow_once" },
              ],
            },
          },
        ],
      };
    case "plan-todo":
      return { surface: "plan", items: [], plan: SAMPLE_PLAN };
    case "interrupted":
      return {
        surface: "thread",
        items: [
          { id: "m-int", kind: "message", author: "agent", authorName: AGENT, text: "Starting the migration now…" },
          { id: "mk-int", kind: "marker", variant: "interrupted", label: "Interrupted", detail: "stopped by you at 2:35 PM" },
        ],
      };
    case "refused":
      return {
        surface: "thread",
        items: [
          { id: "st-refused", kind: "status", status: "refused", label: "Turn ended: refusal", detail: "The agent declined to complete this request." },
        ],
      };
    case "truncated":
      return {
        surface: "thread",
        items: [
          { id: "st-trunc", kind: "status", status: "truncated", label: "Turn ended: max tokens", detail: "Output was cut off — continue to resume.", tokens: { used: 199120, size: 200000 } },
        ],
      };
    case "live-token-cost":
      return {
        surface: "thread",
        items: [
          { id: "usage-1", kind: "usage", usage: { used: 42800, size: 200000, inputTokens: 38200, outputTokens: 4600, costUsd: 0.1284 } },
        ],
      };
    default: {
      const _never: never = id;
      return _never;
    }
  }
}
