import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

test("validates and renders the shared happy-path fixture", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Static session replay" })).toBeVisible();
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

test("shows duplicate and unsupported-version fixture states", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Fixture", { exact: true }).selectOption("duplicate-event");
  await expect(page.getByText("1 duplicate events ignored")).toBeVisible();
  await page
    .getByLabel("Fixture", { exact: true })
    .selectOption("unsupported-required-version");
  await expect(page.getByRole("heading", { name: "Fixture cannot be replayed" })).toBeVisible();
  await expect(page.getByText(/protocolVersion 2 is unsupported/)).toBeVisible();
});
