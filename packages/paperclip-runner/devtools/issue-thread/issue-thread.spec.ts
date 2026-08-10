import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

import { PHASE7_UI_SHOT_SLUGS } from "../../src/issue-thread/fixtures";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

function route(slug: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ shot: slug, capture: "1", ...params });
  return `/#/issue/hb-baseline?${query.toString()}`;
}

/** Every route settles on a data attribute, never on a timeout (§10.1). */
async function open(page: Page, slug: string, params: Record<string, string> = {}) {
  await page.goto(route(slug, params));
  await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();
}

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: unknown[];
}

async function seriousAxeViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const results = await axe.run(document, {
      resultTypes: ["violations"],
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      nodes: violation.nodes.length,
    }));
  });
  return (violations as unknown as AxeViolation[]).filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
}

test.describe("Phase 7G issue thread", () => {
  test("baseline thread renders identity, turns, and the §3 item types", async ({ page }) => {
    await open(page, "thread-baseline");

    await expect(page.locator('[data-session-mode="fake"]').first()).toBeVisible();
    const chips = page.getByTestId("identity-chips");
    await expect(chips.getByTestId("agent-chip")).toHaveText("Fake agent");
    await expect(chips.getByTestId("runner-chip")).toContainText("In-process runner");
    await expect(chips.getByTestId("control-plane-chip")).toHaveText("Mock Paperclip");

    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator('[data-turn-id]')).toHaveCount(3);
    for (const kind of ["user_message", "agent_message", "durable_comment", "tool_activity"]) {
      await expect(page.locator(`[data-thread-item="${kind}"]`).first()).toBeVisible();
    }
    await expect(page.locator('[data-composer-state="ready"]')).toHaveCount(1);
  });

  test("a durable progress comment is visually distinct from model prose", async ({ page }) => {
    await open(page, "thread-baseline");
    await expect(
      page.locator('[data-thread-item="durable_comment"]').getByText("Recorded to mock thread"),
    ).toBeVisible();
    await expect(
      page.locator('[data-thread-item="agent_message"]').first().getByText("Recorded to mock thread"),
    ).toHaveCount(0);
  });

  test("tool strips are collapsed disclosures that deep-link into Evidence", async ({ page }) => {
    await open(page, "thread-baseline");
    const strip = page.locator('[data-tool-strip="get_task_context"] button').first();
    await expect(strip).toHaveAttribute("aria-expanded", "false");
    await strip.click();
    await expect(strip).toHaveAttribute("aria-expanded", "true");

    await page.getByRole("button", { name: "View in Evidence" }).first().click();
    const panel = page.getByTestId("evidence-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-record-id="call-1"][data-highlighted="true"]')).toBeVisible();
  });

  test("a pending question card resolves inline and releases the composer", async ({ page }) => {
    await open(page, "interaction-question-pending");

    await expect(page.locator('[data-composer-state="waiting"]')).toBeVisible();
    const card = page.locator('[data-interaction-id="ix-questions-01"]');
    await expect(card).toHaveAttribute("data-interaction-state", "pending");
    await expect(card.getByTestId("interaction-state-chip")).toContainText("Waiting for you");

    // The submit is rejected until every required question is answered.
    await card.getByRole("button", { name: "Submit answers" }).click();
    await expect(card.getByRole("alert")).toContainText("required");

    await card.getByRole("radio", { name: "Yes — runner owns it" }).check();
    await card.getByRole("combobox").selectOption("hb-baseline");
    await card.getByRole("button", { name: "Submit answers" }).click();

    await expect(card).toHaveAttribute("data-interaction-state", "answered");
    await expect(card.getByTestId("interaction-state-chip")).toContainText("Answered");
    await expect(page.locator('[data-composer-state="ready"]').first()).toBeVisible();
  });

  test("a revision-bound confirmation names its target and requires a reject reason", async ({
    page,
  }) => {
    await open(page, "interaction-confirmation-pending");
    const card = page.locator('[data-interaction-id="ix-confirmation-plan-01"]');
    await expect(card.getByTestId("interaction-target")).toHaveText("plan · r4");

    await card.getByRole("button", { name: "Request changes" }).click();
    await expect(card.getByRole("alert")).toContainText("reason is required");
    await expect(card).toHaveAttribute("data-interaction-state", "pending");

    await card.getByRole("textbox").fill("Split the acceptance section first.");
    await card.getByRole("button", { name: "Request changes" }).click();
    await expect(card).toHaveAttribute("data-interaction-state", "rejected");
    await expect(card).toContainText("Split the acceptance section first.");
  });

  test("resolved, rejected, stale, and superseded cards stay distinct in history", async ({
    page,
  }) => {
    await open(page, "interaction-resolved-mixed");
    for (const state of ["answered", "accepted", "rejected", "stale_target", "superseded_by_comment"]) {
      await expect(
        page.locator(`[data-interaction-state="${state}"]`),
        `missing ${state}`,
      ).toHaveCount(1);
    }
    // Expired treatments keep their controls removed but stay reachable.
    await expect(
      page.locator('[data-interaction-state="stale_target"] button', { hasText: "Approve" }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-interaction-state="stale_target"]').getByRole("button", {
        name: "View request evidence",
      }),
    ).toBeVisible();
  });

  test("the deliverable strip and card report one size in one unit", async ({ page }) => {
    await open(page, "deliverable-registered");
    const card = page.locator('[data-thread-item="deliverable"]');
    await expect(card).toContainText("18.0 kB");
    await expect(
      page.locator('[data-tool-strip="register_deliverable"]'),
    ).toContainText("18.0 kB");
  });

  test("a denial quotes the authorization record verbatim and badges Evidence", async ({
    page,
  }) => {
    await open(page, "denial-optional-tool");
    await expect(page.getByTestId("denial-reason")).toHaveText(
      "denied: missing grant su:read_or_write",
    );
    await expect(page.getByTestId("evidence-toggle")).toContainText("(1)");

    await page.locator('[data-thread-item="denial"]').getByRole("button", { name: "View in Evidence" }).click();
    const record = page.getByTestId("evidence-panel").locator('[data-record-id="authz-deny-1"]');
    await expect(record).toHaveAttribute("data-allowed", "false");
    await expect(record).toContainText("denied: missing grant su:read_or_write");
  });

  test("Evidence exposes eight sections, a turn selector, and the withheld control-plane list", async ({
    page,
  }) => {
    await open(page, "debug-panel-open", { panel: "authorization" });
    const panel = page.getByTestId("evidence-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-evidence-section]")).toHaveCount(8);
    await expect(panel.locator("#evidence-turn-selector")).toBeVisible();

    // The Tools section is open by default; assert its groups directly.
    await expect(
      panel.locator('[data-evidence-section="tools"] button').first(),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByText("Control plane (not exposed to the agent)")).toBeVisible();
    await expect(
      panel.locator('[data-disposition="control_plane_owned"]', { hasText: "create_task" }),
    ).toBeVisible();
    await expect(panel.getByText("Agent tool — always")).toBeVisible();
    await expect(panel.getByText("Agent tool — granted")).toBeVisible();
  });

  test("Evidence records link back to their thread anchor", async ({ page }) => {
    await open(page, "debug-panel-open", { panel: "calls" });
    const panel = page.getByTestId("evidence-panel");
    await panel.locator('[data-record-id="call-1"]').getByRole("button", { name: "Show in thread" }).click();
    await expect(page.locator('[data-tool-strip="get_task_context"]')).toBeInViewport();
  });

  test("the splitter resizes the panel from the keyboard", async ({ page }) => {
    await open(page, "debug-panel-open", { panel: "tools" });
    const splitter = page.getByRole("separator", { name: "Resize the evidence panel" });
    const before = await splitter.getAttribute("aria-valuenow");
    await splitter.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(splitter).not.toHaveAttribute("aria-valuenow", before ?? "");
  });

  test("reset is confirmed, escapable, and clears the thread", async ({ page }) => {
    await open(page, "disposition-terminal");
    await page.getByTestId("reset-button").click();
    const dialog = page.getByTestId("reset-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("The transcript will be lost.");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.getByTestId("reset-button").click();
    await page
      .getByTestId("reset-dialog")
      .getByRole("button", { name: "Reset scenario", exact: true })
      .click();
    await expect(page.locator('[data-thread-item="disposition"]')).toHaveCount(0);
    await expect(page.locator('[data-composer-state="ready"]').first()).toBeVisible();
  });

  test("stop keeps the partial turn and marks it", async ({ page }) => {
    await open(page, "turn-streaming");
    await expect(page.locator('[data-composer-state="streaming"]')).toBeVisible();
    await expect(page.getByTestId("composer-stop")).toBeVisible();
    await expect(page.locator('[data-composer-state="streaming"] textarea')).toBeEnabled();

    await page.getByTestId("composer-stop").click();
    await expect(page.getByTestId("stopped-marker")).toBeVisible();
    await expect(page.locator('[data-thread-item="agent_message"]').last()).toContainText(
      "Two dependent tasks are still open",
    );
  });

  test("reconnect pins an amber banner and disables the composer", async ({ page }) => {
    await open(page, "reconnect-banner");
    await expect(page.getByTestId("reconnect-banner")).toContainText("attempt 2");
    await expect(page.locator('[data-composer-state="reconnecting"]')).toBeVisible();
    await expect(page.locator('[data-composer-state="reconnecting"] textarea')).toBeDisabled();

    await page.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByText("Reconnected")).toBeVisible();
  });

  test("replay is read-only and labelled as fake-derived", async ({ page }) => {
    await open(page, "replay-mode");
    await expect(page.getByTestId("agent-chip")).toContainText("Replay · fake source");
    await expect(page.getByTestId("composer-reason")).toHaveText("Replay is read-only");
    await expect(page.getByTestId("replay-strip")).toContainText("Replay 12/18");
    await expect(page.locator('[data-composer-state="disabled"] textarea')).toBeDisabled();
  });

  test("the replay strip steps, advances, and plays through to the end", async ({ page }) => {
    await open(page, "replay-mode");
    const strip = page.getByTestId("replay-strip");
    const progress = page.getByRole("progressbar", { name: "Replay progress" });

    await page.getByTestId("replay-step-back").click();
    await expect(strip).toContainText("Replay 11/18");
    await expect(progress).toHaveAttribute("aria-valuenow", "11");

    await page.getByTestId("replay-next-turn").click();
    await expect(strip).toContainText("Replay 12/18");

    // Play-all runs the recording out and parks itself at the last ordinal
    // instead of leaving the operator to click Next turn eighteen times (§6).
    const playAll = page.getByTestId("replay-play-all");
    await playAll.click();
    await expect(playAll).toHaveAttribute("aria-pressed", "true");
    await expect(strip).toContainText("Replay 18/18", { timeout: 15_000 });
    await expect(playAll).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("replay-next-turn")).toBeDisabled();
  });

  test("a terminal disposition disables the composer with a reason", async ({ page }) => {
    await open(page, "disposition-terminal");
    await expect(page.locator('[data-thread-item="disposition"]')).toContainText("Done");
    await expect(page.getByTestId("composer-reason")).toHaveText("Issue is done");
  });

  test("composer drafts survive a refresh", async ({ page }) => {
    await open(page, "thread-baseline");
    await page.locator("#composer-input").fill("Draft that must survive F5.");
    await page.reload();
    await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();
    await expect(page.locator("#composer-input")).toHaveValue("Draft that must survive F5.");
  });

  test("mobile keeps the thread usable with no horizontal page scroll", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await open(page, "turn-streaming");

    const overflow = await page.evaluate(() => {
      const element = document.scrollingElement as HTMLElement;
      return element.scrollWidth - element.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);

    // Stop stays outside the overflow menu while a turn is active (§2.2).
    await expect(page.getByTestId("stop-button")).toBeVisible();
    await expect(page.getByTestId("stop-button")).toBeEnabled();
    await expect(page.getByTestId("overflow-menu")).toHaveCount(0);

    await page.getByTestId("segment-evidence").click();
    await expect(page.getByTestId("evidence-panel")).toBeVisible();
    await expect(page.getByTestId("evidence-panel")).toHaveAttribute("data-layout", "segment");
  });

  test("mobile surfaces the denial count on the Evidence segment", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await open(page, "denial-optional-tool");
    await expect(page.getByTestId("segment-denial-badge")).toHaveText("1");
  });

  test("every actionable control meets the 44px touch target on mobile", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await open(page, "interaction-question-pending");
    const undersized = await page.evaluate(() => {
      const selectors = "button:not([hidden]), select, textarea, [role='radio']";
      return [...document.querySelectorAll(selectors)]
        .filter((node) => {
          const element = node as HTMLElement;
          if (element.offsetParent === null) return false;
          const rect = element.getBoundingClientRect();
          return rect.height < 44;
        })
        .map((node) => (node as HTMLElement).className || node.tagName);
    });
    expect(undersized).toEqual([]);
  });

  test("the mobile overflow menu closes with Escape", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await open(page, "thread-baseline");
    await page.getByTestId("overflow-menu-button").click();
    await expect(page.getByTestId("overflow-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("overflow-menu")).toHaveCount(0);
  });

  test("opening Evidence moves focus to its heading", async ({ page }) => {
    await open(page, "thread-baseline");
    await page.getByTestId("evidence-toggle").click();
    await expect(page.getByRole("heading", { name: "Evidence" })).toBeFocused();
  });

  test("Escape closes the desktop overlay sheet and returns focus to its toggle", async ({
    page,
  }) => {
    // Between the mobile segment and the docked side panel, Evidence renders as
    // an overlay sheet; §9.1 makes Escape dismiss it.
    await page.setViewportSize({ width: 1000, height: 800 });
    await open(page, "thread-baseline");
    await page.getByTestId("evidence-toggle").click();

    const panel = page.getByTestId("evidence-panel");
    await expect(panel).toHaveAttribute("data-layout", "overlay");
    await expect(page.getByRole("heading", { name: "Evidence" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("evidence-toggle")).toBeFocused();
  });

  test("resolving an interaction card moves focus to its state chip", async ({ page }) => {
    await open(page, "interaction-question-pending");
    const card = page.locator('[data-interaction-id="ix-questions-01"]');

    await card.getByRole("radio", { name: "Yes — runner owns it" }).check();
    await card.getByRole("combobox").selectOption("hb-baseline");
    await card.getByRole("button", { name: "Submit answers" }).click();

    await expect(card).toHaveAttribute("data-interaction-state", "answered");
    await expect(card.getByTestId("interaction-state-chip")).toBeFocused();
  });

  test("the waiting composer anchor focuses the pending card", async ({ page }) => {
    await open(page, "interaction-question-pending");
    await page.getByTestId("pending-anchor").click();
    await expect(page.locator('[data-interaction-id="ix-questions-01"]')).toBeInViewport();
  });

  for (const slug of PHASE7_UI_SHOT_SLUGS) {
    test(`axe reports no serious or critical violation on ${slug} (desktop)`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await open(page, slug, slug === "debug-panel-open" ? { panel: "authorization" } : {});
      expect(await seriousAxeViolations(page)).toEqual([]);
    });

    test(`axe reports no serious or critical violation on ${slug} (mobile)`, async ({ page }) => {
      await page.setViewportSize(MOBILE);
      await open(page, slug, slug === "debug-panel-open" ? { panel: "authorization", seg: "evidence" } : {});
      expect(await seriousAxeViolations(page)).toEqual([]);
    });
  }
});

/* ------------------------------------------------------- Phase 7M clean room */

/**
 * The clean room is live-only by construction, so these tests stub the package
 * session route rather than starting a real Codex process: what is under test
 * here is the surface — entry, blank state, evidence-on-demand, identity
 * rotation, failure honesty, and the narrow layout — not the tool loop, which
 * `smoke:phase7:cleanroom` and the server suite cover against the real thing.
 */

const CLEAN_ROOM_API = "**/api/phase7/ui/cleanroom/session*";

function cleanRoomView(identifier: string, withTurn: boolean) {
  const guard = {
    id: `network-guard-session-${identifier}`,
    turnId: "turn-0",
    category: "session",
    outcome: "no_real_paperclip_request",
    reason: "Real Paperclip API requests: 0. Child PAPERCLIP_* environment keys: none.",
    stateRevision: 3,
    threadAnchorId: null,
  };
  return {
    schema: "paperclip.phase7.issue-thread-view.v1",
    sessionId: `session-${identifier}`,
    mode: "live",
    identity: {
      agentLabel: "Real Codex",
      runnerLabel: "Real runnerd",
      runnerAttached: true,
      controlPlaneLabel: "Mock Paperclip",
      controlPlaneTooltip: "All issue records are mock. No real Paperclip API is reachable.",
      replaySource: null,
    },
    issue: {
      identifier,
      title: "Clean-room chat",
      status: "in_progress",
      priority: "medium",
      assignee: "Mock Agent",
      runState: `run-${identifier} · idle`,
      scenarioId: "phase7-clean-room",
      fixtureProfile: "clean-room",
    },
    turns: withTurn
      ? [
          {
            id: "turn-1",
            ordinal: 1,
            mode: "live",
            toolCallCount: 1,
            at: "2026-08-10T12:00:00.000Z",
            stoppedByUser: false,
            items: [
              {
                kind: "user_message",
                id: "transcript-1",
                at: "2026-08-10T12:00:00.000Z",
                author: "You (board user)",
                body: "Read this issue and record a status.",
              },
              {
                kind: "tool_activity",
                id: "item-call-call-1",
                at: "2026-08-10T12:00:01.000Z",
                status: "ok",
                operationId: "report_progress",
                summary: "state revision 3",
                input: { body: "first status" },
                result: { ok: true, stateRevision: 3 },
                evidenceRef: { section: "calls", recordId: "call-1" },
              },
              {
                kind: "agent_message",
                id: "transcript-2",
                at: "2026-08-10T12:00:02.000Z",
                author: "Real Codex",
                body: "Recorded a first status on the mock issue.",
                streaming: false,
              },
            ],
          },
        ]
      : [],
    composer: { state: "ready", helper: null, reason: null, pendingInteractionId: null },
    evidence: {
      tools: [],
      calls: [],
      authorization: [],
      control_plane: [guard],
      runner: [],
      state: [],
      traceability: [],
      parity: [],
    },
    connection: { state: "connected", attempt: 0 },
    replay: null,
    renderedAt: "2026-08-10T12:00:02.000Z",
  };
}

function cleanRoomPayload(identifier: string, withTurn = false) {
  return {
    sessionId: `session-${identifier}`,
    surface: "cleanroom",
    identity: {
      token: identifier.toLowerCase().replace("mck-", "tok"),
      sequence: Number(identifier.slice(4)),
      companyId: `company-cleanroom-${identifier}`,
      actorId: `actor-cleanroom-${identifier}`,
      taskId: `task-cleanroom-${identifier}`,
      identifier,
    },
    limits: { maxTurns: 24, maxMessageBytes: 8192 },
    view: cleanRoomView(identifier, withTurn),
  };
}

async function stubCleanRoom(page: Page, identifiers: string[]) {
  let opened = 0;
  await page.route(CLEAN_ROOM_API, async (route) => {
    const identifier = identifiers[Math.min(opened, identifiers.length - 1)] ?? "MCK-1000";
    opened += 1;
    await route.fulfill({
      status: route.request().method() === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify(cleanRoomPayload(identifier)),
    });
  });
}

async function openCleanRoom(page: Page, identifiers: string[] = ["MCK-1000"]) {
  await stubCleanRoom(page, identifiers);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/#/chat");
  await expect(page.locator('[data-thread-state="settled"]')).toBeVisible();
}

test.describe("Phase 7M clean-room chat", () => {
  test("the landing surface offers a clean-room entry that needs no scenario", async ({ page }) => {
    await open(page, "thread-baseline");
    const entry = page.getByTestId("surface-chat-link");
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("href", "#/chat");
    await expect(entry).toContainText("New chat");
  });

  test("a new chat opens a blank live thread with no scenario controls", async ({ page }) => {
    await openCleanRoom(page);

    await expect(page.locator('[data-surface="chat"]')).toBeVisible();
    await expect(page.getByTestId("clean-room-empty")).toBeVisible();
    await expect(page.locator("[data-turn-id]")).toHaveCount(0);
    await expect(page.getByTestId("scenario-picker")).toHaveCount(0);
    await expect(page.getByTestId("replay-button")).toHaveCount(0);
    await expect(page.getByTestId("replay-strip")).toHaveCount(0);

    const chips = page.getByTestId("identity-chips");
    await expect(chips.getByTestId("agent-chip")).toHaveText("Real Codex");
    await expect(chips.getByTestId("runner-chip")).toContainText("Real runnerd");
    await expect(chips.getByTestId("control-plane-chip")).toHaveText("Mock Paperclip");
    await expect(page.locator('[data-composer-state="ready"]')).toHaveCount(1);
  });

  test("evidence stays collapsed until it is asked for", async ({ page }) => {
    await openCleanRoom(page);

    await expect(page.locator(".pit-panel")).toHaveCount(0);
    await expect(page.getByTestId("evidence-toggle")).toHaveAttribute("aria-expanded", "false");

    await page.getByTestId("evidence-toggle").click();
    await expect(page.locator(".pit-panel")).toBeVisible();
    await page.getByRole("button", { name: /Control plane/ }).click();
    await expect(page.getByText("Real Paperclip API requests: 0")).toBeVisible();
  });

  test("a sent message renders the live turn it produced", async ({ page }) => {
    await openCleanRoom(page);
    await page.route("**/api/phase7/ui/message", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "session-MCK-1000",
          surface: "cleanroom",
          identity: cleanRoomPayload("MCK-1000").identity,
          limits: { maxTurns: 24, maxMessageBytes: 8192 },
          view: cleanRoomView("MCK-1000", true),
        }),
      });
    });

    await page.locator("#composer-input").fill("Read this issue and record a status.");
    await page.getByTestId("composer-send").click();

    await expect(page.getByTestId("clean-room-empty")).toHaveCount(0);
    await expect(page.locator('[data-thread-item="user_message"]')).toBeVisible();
    await expect(page.locator('[data-thread-item="agent_message"]')).toBeVisible();
    await expect(page.locator('[data-tool-strip="report_progress"]')).toBeVisible();
  });

  test("New chat visibly rotates the mock identity", async ({ page }) => {
    await openCleanRoom(page, ["MCK-1000", "MCK-2000"]);
    await expect(page.locator(".pit-identifier")).toHaveText("MCK-1000");

    await page.getByTestId("new-chat-button").click();
    await expect(page.locator(".pit-identifier")).toHaveText("MCK-2000");
    await expect(page.getByTestId("clean-room-empty")).toBeVisible();
  });

  test("a failed live start reports the failure instead of a fixture", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.route(CLEAN_ROOM_API, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "phase7_issue_thread_unavailable",
          message: "paperclip-runnerd exited before the Codex app-server was ready",
        }),
      });
    });
    await page.goto("/#/chat");

    const error = page.getByTestId("surface-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("could not start a real Codex session");
    await expect(page.getByTestId("surface-error-retry")).toBeVisible();
    await expect(page.locator("[data-turn-id]")).toHaveCount(0);
  });

  test("the narrow layout keeps thread and composer usable without horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await openCleanRoom(page);

    await expect(page.getByTestId("clean-room-empty")).toBeVisible();
    await expect(page.locator("#composer-input")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByTestId("segment-evidence").click();
    await expect(page.locator(".pit-panel")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });

  test("axe reports no serious or critical violation on the clean room", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openCleanRoom(page);
    expect(await seriousAxeViolations(page)).toEqual([]);

    await page.setViewportSize(MOBILE);
    await expect(page.getByTestId("clean-room-empty")).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
});
