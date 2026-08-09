import { chromium } from "@playwright/test";

const exe = "/srv/paperclip/home/paperclipai/paperclip/.paperclip/browser-runtime/chromium-arm64/bin/chromium-agent-browser";
const url = "file:///srv/paperclip/home/paperclipai/paperclip/.paperclip/worktrees/PAP-16679-paperclip-runner/packages/paperclip-runner/docs/design/mockups/phase-7-scenario-explorer.html";
const out = "knowledge/evidence/phase-07";

const browser = await chromium.launch({ executablePath: exe });
for (const [w, h, tag] of [[1440, 900, "1440x900"], [390, 844, "390x844"]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(url);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/mockup-explorer-ap-mcp-gate-${tag}.png` });
  await page.close();
}
await browser.close();
console.log("done");
