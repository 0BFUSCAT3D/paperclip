import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 7F browser acceptance.
 *
 * Covers the interaction map's determinism contract (§7), the keyboard paths
 * and landmark structure (§6), and the credential/policy boundary (§5). Screen
 * captures for the §9 acceptance matrix are recorded by
 * `scripts/record-phase7-evidence.mjs`, which reuses the same routes.
 */

const BASE = "/phase7-explorer/";

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`${BASE}${hash}`);
  await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
    "data-run-state",
    "settled",
    { timeout: 30_000 },
  );
}

test.describe("shell and information architecture", () => {
  test("explorer home shows all 16 groups summing to 106 with no dead panel", async ({ page }) => {
    await open(page, "#/");
    await expect(page.locator('[data-testid="scenario-count"]')).toHaveText("106 of 106 scenarios");
    await expect(page.locator('[data-testid="explorer-intro"]')).toBeVisible();

    const counts = await page
      .locator('[data-testid^="facet-group-"] .pcr7-facet-count')
      .allTextContents();
    expect(counts).toHaveLength(16);
    expect(counts.reduce((total, value) => total + Number(value), 0)).toBe(106);

    await expect(page.locator("nav[aria-label='Scenario picker']")).toBeVisible();
    await expect(page.locator("main#run-view")).toBeVisible();
    await expect(page.locator("aside[aria-label='Scenario inspector']")).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("filtered picker route renders chips, counts, and a way out", async ({ page }) => {
    await open(page, "#/?group=ix&disposition=always_agent_tool&parity=not_run");
    await expect(page.locator('[data-testid="active-filter-group"]')).toBeVisible();
    await expect(page.locator('[data-testid="active-filter-disposition"]')).toBeVisible();
    await expect(page.locator('[data-testid="clear-filters"]')).toBeVisible();
    await expect(page.locator('[data-testid="scenario-count"]')).toContainText("of 106 scenarios");
    // A zero-count value stays legible but is not clickable.
    await expect(page.locator('[data-testid="facet-parity-fail"]')).toBeDisabled();
  });
});

test.describe("route determinism", () => {
  test("two loads of the same run route produce identical settled DOM", async ({ page }) => {
    const route = "#/case/ap-mcp-gate-01?run=fake&view=authorization";
    await open(page, route);
    const first = await page.locator('[data-testid="explorer-shell"]').innerHTML();
    await page.reload();
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
      "data-run-state",
      "settled",
      { timeout: 30_000 },
    );
    const second = await page.locator('[data-testid="explorer-shell"]').innerHTML();
    expect(second).toBe(first);
  });

  test("a fake run renders fixture time only", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake&view=transcript");
    const text = (await page.locator('[data-testid="transcript"]').innerText()).toLowerCase();
    const currentYear = String(new Date().getUTCFullYear());
    expect(text).not.toContain(`${currentYear}-`);
    await expect(page.locator('[data-testid="transcript"] [data-channel="control_plane"]').first()).toContainText(
      "no agent tool exists for this",
    );
  });

  test("an unrun scenario primes the run rather than showing a dead panel", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01");
    await expect(page.locator('[data-testid="run-header"]')).toBeVisible();
    await expect(page.locator("main")).toContainText("Run to produce the deterministic timeline.");
    await expect(page.locator('[data-testid="run-button"]')).toBeVisible();
  });
});

test.describe("acceptance evidence", () => {
  test("authorization view shows a deny row and a tab deny count", async ({ page }) => {
    await open(page, "#/case/ap-mcp-gate-01?run=fake&view=authorization");
    await expect(page.locator('[data-testid="panel-authorization"] tr[data-outcome="denied"]')).toHaveCount(1);
    await expect(page.locator('[role="tab"]', { hasText: "Authorization" })).toContainText("deny");
    await expect(page.locator('[data-testid="transcript"] [data-outcome="denied"]').first()).toContainText(
      "required_claim_missing",
    );
  });

  test("context view lists optional tools with the grant that unlocked them", async ({ page }) => {
    await open(page, "#/case/rf-api-mgr-heartbeat-01?run=fake&view=context");
    await expect(page.locator('[data-testid="exposure-optional"]')).toContainText("discovery:agents:read");
    await expect(page.locator('[data-testid="exposure-control-plane"]')).toContainText("checkout_task");
    await expect(page.locator('[data-testid="panel-context"]')).toContainText("Manager");
  });

  test("state diff collapses unchanged domains and marks changes with icon plus label", async ({ page }) => {
    await open(page, "#/case/bl-create-blocked-01?run=fake&view=diff");
    await expect(page.locator('[data-testid="diff-domain-blockers"]')).toHaveAttribute("data-changed", "true");
    await expect(page.locator('[data-testid="diff-domain-approvals"]')).toHaveAttribute("data-changed", "false");
    await expect(page.locator('[data-testid="diff-domain-tasks"]')).toContainText("Added");
  });

  test("restraint reads as deliberate absence, not an empty screen", async ({ page }) => {
    await open(page, "#/case/rs-question-only-01?run=fake&view=parity");
    await expect(page.locator('[data-testid="restraint-note"]')).toContainText("No further operations");
    await expect(page.locator('[data-testid="parity-verdict"]')).toContainText("Pass");
    await expect(page.locator('[data-testid="parity-forbidden"]')).toBeVisible();
  });

  test("redaction chips name the rule and never the value", async ({ page }) => {
    await open(page, "#/case/rs-secret-hygiene-01?run=fake&view=transcript");
    await page.locator('[data-testid="transcript"] details').first().evaluate((node) => {
      for (const element of document.querySelectorAll("details")) element.setAttribute("open", "");
      return node.tagName;
    });
    await expect(page.locator('[data-testid="redaction-chip"]').first()).toBeVisible();
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("fixture-secret-value-not-a-real-credential");
  });
});

test.describe("credential and policy boundary", () => {
  test("fake mode performs no network request beyond its own assets", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith("http://127.0.0.1:4193")) external.push(request.url());
    });
    await open(page, "#/case/mh-subtask-tree-01?run=fake&view=parity");
    expect(external).toEqual([]);
  });

  test("localStorage holds no run artifact, grant, or fixture payload", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake");
    const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(stored).toBe("{}");
  });

  test("Codex mode is disabled with a stated reason and fake mode stays usable", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake");
    await expect(page.locator('[data-testid="mode-codex"]')).toBeDisabled();
    await expect(page.locator('[data-testid="codex-unavailable"]')).toContainText(
      "provider relay not running",
    );
    await expect(page.locator('[data-testid="mode-fake"]')).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("keyboard and accessibility", () => {
  test("the picker listbox moves selection with the arrow keys", async ({ page }) => {
    await open(page, "#/?group=ix");
    const list = page.locator('[data-testid="case-list"]');
    await list.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('[data-testid="case-list"] [aria-selected="true"]')).toHaveCount(1);
    const first = await page.locator('[data-testid="case-list"] [aria-selected="true"]').getAttribute("id");
    await list.focus();
    await page.keyboard.press("ArrowDown");
    const second = await page.locator('[data-testid="case-list"] [aria-selected="true"]').getAttribute("id");
    expect(second).not.toBe(first);
    await expect(list).toHaveAttribute("aria-activedescendant", String(second));
  });

  test("inspector tabs follow the WAI-ARIA arrow-key pattern", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake&view=context");
    // Exactly one tablist on the page: the mobile section switcher is a
    // radiogroup so the three landmarks are not modelled as tabpanels.
    await expect(page.locator('[role="tablist"]')).toHaveCount(1);
    const selected = page.locator('[role="tab"][aria-selected="true"]');
    await page.locator('[role="tab"]').first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(selected).toContainText("Authorization");
    await page.keyboard.press("ArrowRight");
    await expect(selected).toContainText("State diff");
    await expect(page.locator('[role="tabpanel"]')).toBeVisible();
  });

  test("every interactive control is reachable and named", async ({ page }) => {
    await open(page, "#/case/ap-mcp-gate-01?run=fake&view=authorization");
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll("button, input, [role='tab'], [role='radio']")]
        .filter((element) => {
          const label =
            element.getAttribute("aria-label") ??
            element.getAttribute("title") ??
            (element.textContent ?? "").trim();
          const labelled =
            element.id.length > 0 &&
            document.querySelector(`label[for="${CSS.escape(element.id)}"]`) !== null;
          return label.length === 0 && !labelled;
        })
        .map((element) => element.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
  });

  test("run progress is announced through a polite live region", async ({ page }) => {
    await open(page, "#/case/hb-scoped-wake-01?run=fake");
    await expect(page.locator('[role="status"][aria-live="polite"]')).toContainText(
      "Scenario run settled — verdict pass",
    );
  });
});

test.describe("responsive", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile shows one segment at a time with no horizontal scrollbar", async ({ page }) => {
    await open(page, "#/case/ap-mcp-gate-01?run=fake&view=transcript");
    await expect(page.locator('[data-testid="segment-run"]')).toBeVisible();
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute("data-segment", "run");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("mobile inspector routes open the Inspect segment", async ({ page }) => {
    await open(page, "#/case/rf-api-mgr-heartbeat-01?run=fake&view=context");
    await expect(page.locator('[data-testid="explorer-shell"]')).toHaveAttribute(
      "data-segment",
      "inspect",
    );
    await expect(page.locator('[data-testid="panel-context"]')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
