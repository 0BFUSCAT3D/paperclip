#!/usr/bin/env node
/**
 * Records the Phase 7B §10.2 screenshot matrix: 12 slugs × 2 viewports.
 *
 * Every route is deterministic `fake` mode served from package fixtures — no
 * provider, runnerd, or credential is involved, so the PNGs are safe evidence
 * and reproduce byte-for-byte from a clean checkout. `--check` re-records into
 * a scratch directory and compares bytes instead of overwriting.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { PHASE7_UI_SHOT_SLUGS } from "../dist/issue-thread/fixtures.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(packageRoot, "knowledge/evidence/phase-07/ui");
const PORT = Number.parseInt(process.env.PAPERCLIP_PHASE7_UI_PORT ?? "4185", 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/** Slugs whose evidence needs an extra deep-link parameter. */
const EXTRA_PARAMS = {
  "debug-panel-open": { desktop: { panel: "authorization" }, mobile: { panel: "authorization", seg: "evidence" } },
  "replay-mode": { desktop: { at: "12" }, mobile: { at: "12" } },
};

function routeFor(slug, viewport) {
  const params = new URLSearchParams({
    shot: slug,
    capture: "1",
    ...(EXTRA_PARAMS[slug]?.[viewport] ?? {}),
  });
  return `${ORIGIN}/#/issue/hb-baseline?${params.toString()}`;
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server is still binding.
    }
    if (Date.now() > deadline) throw new Error(`preview server never answered on ${url}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function startPreview() {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--config",
      "vite.phase7.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
    ],
    { cwd: packageRoot, stdio: "ignore", env: { ...process.env, NODE_ENV: "" } },
  );
  await waitForServer(ORIGIN);
  return async () => {
    child.kill("SIGTERM");
  };
}

// Set by `record` so a drift report can name the Chromium build that produced it.
let browserVersion = "unknown";

async function record(targetDir) {
  await mkdir(targetDir, { recursive: true });
  const browser = await chromium.launch({
    ...(process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH === undefined
      ? {}
      : { executablePath: process.env.PAPERCLIP_RUNNER_CHROMIUM_PATH }),
  });
  browserVersion = browser.version();
  const recorded = [];
  try {
    for (const viewport of VIEWPORTS) {
      for (const slug of PHASE7_UI_SHOT_SLUGS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
          colorScheme: "dark",
          locale: "en-US",
          timezoneId: "UTC",
        });
        const page = await context.newPage();
        await page.goto(routeFor(slug, viewport.name));
        // Settle on the contract's data attribute, never on a timeout.
        await page.waitForSelector('[data-thread-state="settled"]', { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);

        const overflow = await page.evaluate(() => {
          const element = document.scrollingElement;
          return element.scrollWidth - element.clientWidth;
        });
        if (viewport.name === "mobile" && overflow > 0) {
          throw new Error(`${slug} scrolls horizontally by ${overflow}px at 390px`);
        }

        const file = resolve(targetDir, `${slug}--${viewport.name}.png`);
        await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
        recorded.push({ slug, viewport: viewport.name, file, overflow });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return recorded;
}

async function main() {
  const check = process.argv.includes("--check");
  const stop = await startPreview();
  try {
    if (!check) {
      await rm(OUTPUT_DIR, { recursive: true, force: true });
      const recorded = await record(OUTPUT_DIR);
      const manifest = recorded.map(({ slug, viewport }) => `${slug}--${viewport}.png`).sort();
      await writeFile(
        resolve(OUTPUT_DIR, "index.md"),
        [
          "# Phase 7 issue-thread UI evidence",
          "",
          "Recorded by `pnpm --filter @paperclipai/paperclip-runner record:phase7:ui`.",
          "Deterministic `fake` mode; no provider, runner, or credential is involved.",
          "",
          ...manifest.map((name) => `- \`${name}\``),
          "",
        ].join("\n"),
        "utf8",
      );
      process.stdout.write(`Recorded ${recorded.length} Phase 7 UI screenshots to ${OUTPUT_DIR}\n`);
      return;
    }

    const scratchRoot =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
    const scratch = await mkdtemp(resolve(scratchRoot, "phase7-ui-check-"));
    try {
      const recorded = await record(scratch);
      const drift = [];
      for (const entry of recorded) {
        const committed = resolve(OUTPUT_DIR, `${entry.slug}--${entry.viewport}.png`);
        const [expected, actual] = await Promise.all([
          readFile(committed).catch(() => null),
          readFile(entry.file),
        ]);
        if (expected === null || !expected.equals(actual)) {
          drift.push(`${entry.slug}--${entry.viewport}.png`);
        }
      }
      const committedNames = (await readdir(OUTPUT_DIR).catch(() => [])).filter((name) =>
        name.endsWith(".png"),
      );
      if (committedNames.length !== recorded.length) {
        drift.push(
          `expected ${recorded.length} committed PNGs, found ${committedNames.length}`,
        );
      }
      if (drift.length > 0) {
        process.stderr.write(
          [
            "Phase 7 UI evidence is not byte-stable:",
            ...drift,
            "",
            `Recorded with Chromium ${browserVersion}.`,
            "Committed PNGs are pinned to one Chromium build. A wholesale mismatch",
            "usually means a different browser, not a UI regression: set",
            "PAPERCLIP_RUNNER_CHROMIUM_PATH to the Chromium that recorded them.",
            "",
          ].join("\n"),
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `All ${recorded.length} Phase 7 UI screenshots reproduce byte-for-byte.\n`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } finally {
    await stop();
  }
}

await main();
