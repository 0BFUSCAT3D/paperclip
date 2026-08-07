import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

test("validates and renders the shared Phase 1 fixture", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Static replay" }).click();
  await expect(page.getByRole("heading", { name: "Live local runner" })).toBeVisible();
  await expect(page.getByTestId("terminal-badge")).toHaveText("succeeded");
  await expect(page.getByTestId("timeline").getByRole("listitem")).toHaveCount(9);
  await expect(page.getByTestId("result-summary")).toContainText(
    "The scripted run completed successfully.",
  );
  await page.screenshot({
    path: resolve(packageRoot, "knowledge/evidence/phase-01-static-replay.png"),
    fullPage: true,
  });
});

test("shows duplicate and unsupported-version replay states", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Static replay" }).click();
  await page.getByLabel("Fixture", { exact: true }).selectOption("duplicate-event");
  await expect(page.getByText("1 duplicate events ignored")).toBeVisible();
  await page
    .getByLabel("Fixture", { exact: true })
    .selectOption("unsupported-required-version");
  await expect(page.getByRole("heading", { name: "Fixture cannot be replayed" })).toBeVisible();
  await expect(page.getByText(/protocolVersion 2 is unsupported/)).toBeVisible();
});

test("streams a live run and proves replay parity", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start local run" }).click();
  await expect(page.getByTestId("live-status")).toHaveText("terminal");
  await expect(page.getByTestId("terminal-badge")).toHaveText("succeeded");
  await expect(page.getByTestId("process-facts")).toContainText("Harness process exit");
  await expect(page.getByTestId("process-facts")).toContainText("done");
  await expect(page.getByTestId("parity-result")).toContainText("Match");
  await page.screenshot({
    path: resolve(packageRoot, "knowledge/evidence/phase-02-live-complete.png"),
    fullPage: true,
  });
});

test("resolves live permission and input requests", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Scenario").selectOption("permission-input");
  await page.getByRole("button", { name: "Start local run" }).click();
  await expect(page.getByTestId("runtime-request")).toContainText("permission request");
  await page.screenshot({
    path: resolve(packageRoot, "knowledge/evidence/phase-02-live-permission.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("runtime-request")).toContainText("input request");
  await page.getByLabel("Response").fill("phase-02-browser-trace");
  await page.getByRole("button", { name: "Send input" }).click();
  await expect(page.getByTestId("live-status")).toHaveText("terminal");
  await expect(page.getByTestId("parity-result")).toContainText("Match");
});

test("interrupts a live turn without duplicating terminal state", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Scenario").selectOption("interrupted");
  await page.getByRole("button", { name: "Start local run" }).click();
  const interrupt = page.getByRole("button", { name: "Interrupt turn" });
  await expect(interrupt).toBeEnabled();
  await interrupt.click();
  await expect(page.getByTestId("live-status")).toHaveText("terminal");
  await expect(page.getByTestId("terminal-badge")).toHaveText("cancelled");
  await expect(page.getByTestId("timeline").getByText("run.terminal")).toHaveCount(1);
  await page.screenshot({
    path: resolve(packageRoot, "knowledge/evidence/phase-02-live-interrupted.png"),
    fullPage: true,
  });
});
