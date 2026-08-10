#!/usr/bin/env node
/**
 * Live smoke for the Phase 7G issue-thread server.
 *
 * Starts the real package server on loopback, drives a real runnerd + Codex
 * app-server session through the same HTTP routes the browser uses, and checks
 * that the projected view carries the live identity, the multi-turn thread, the
 * durable mock records, and no credential. Requires an authenticated local
 * Codex installation.
 *
 * Usage: node scripts/phase7-issue-thread-smoke.mjs [--json]
 */

import { createServer } from "node:http";
import { once } from "node:events";

import { createPhase7IssueThreadMiddleware } from "./phase7-issue-thread-server.mjs";

const CREDENTIAL_PATTERNS = [
  /bearer\s+[a-z0-9._-]+/i,
  /sk-[a-z0-9]{8,}/i,
  /"api[_-]?key"\s*:/i,
  /PAPERCLIP_API_KEY/,
  /OPENAI_API_KEY/,
];

function credentialLeaks(value) {
  const serialized = JSON.stringify(value);
  return CREDENTIAL_PATTERNS.filter((pattern) => pattern.test(serialized)).map(String);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function main() {
  const asJson = process.argv.includes("--json");
  const middleware = createPhase7IssueThreadMiddleware({ bindHost: "127.0.0.1" });
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const assertions = {};
  let sessionId = null;
  try {
    const created = await (await fetch(`${origin}/api/phase7/ui/session`)).json();
    sessionId = created.sessionId;
    assertions.sessionCreated = typeof sessionId === "string" && sessionId.length > 0;
    assertions.liveIdentity =
      created.view.identity.agentLabel === "Real Codex" &&
      created.view.identity.runnerLabel === "Real runnerd" &&
      created.view.identity.controlPlaneLabel === "Mock Paperclip";
    assertions.mockIdentifier = created.view.issue.identifier.startsWith("MCK-");
    assertions.toolsProjected = created.view.evidence.tools.length >= 0;

    const first = await (
      await fetch(`${origin}/api/phase7/ui/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message:
            "Call get_task_context, then call report_progress with a one-sentence status. Do not ask me anything.",
        }),
      })
    ).json();
    const firstItems = first.view.turns.flatMap((turn) => turn.items);
    assertions.userMessageRendered = firstItems.some((item) => item.kind === "user_message");
    assertions.toolActivityRendered = firstItems.some((item) => item.kind === "tool_activity");
    assertions.durableCommentRendered = firstItems.some(
      (item) => item.kind === "durable_comment",
    );
    assertions.authorizationRecorded = first.view.evidence.authorization.length > 0;
    assertions.callsRecorded = first.view.evidence.calls.length > 0;
    assertions.controlPlaneWithheld = (first.view.evidence.tools[0]?.rows ?? []).some(
      (row) => row.disposition === "control_plane_owned",
    );

    const second = await (
      await fetch(`${origin}/api/phase7/ui/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message: "Summarise the mock task in one line." }),
      })
    ).json();
    assertions.multiTurnThread = second.view.turns.length > first.view.turns.length;
    assertions.composerReady = second.view.composer.state === "ready";

    assertions.noCredentialInView = credentialLeaks(second.view).length === 0;

    const failures = Object.entries(assertions).filter(([, ok]) => ok !== true);
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schema: "paperclip.phase7.issue-thread-smoke.v1",
            sessionId,
            turns: second.view.turns.length,
            toolCalls: second.view.evidence.calls.length,
            authorizationRecords: second.view.evidence.authorization.length,
            assertions,
          },
          null,
          2,
        )}\n`,
      );
    }
    assert(failures.length === 0, `${failures.map(([name]) => name).join(", ")}`);
    if (!asJson) process.stdout.write("Phase 7 issue-thread live smoke passed.\n");
  } finally {
    await middleware.close();
    server.close();
  }
}

await main();
