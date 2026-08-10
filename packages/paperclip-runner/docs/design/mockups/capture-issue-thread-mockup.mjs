import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const root = new URL("./phase-7-issue-thread.html", import.meta.url).href;
const outDir = process.env.OUT_DIR;
mkdirSync(outDir, { recursive: true });

const shots = [
  ["thread-pending-confirmation", "?state=pending"],
  ["thread-baseline", "?state=baseline"],
  ["thread-resolved-denial-panel", "?state=resolved&panel=open"],
  ["turn-streaming", "?state=streaming"],
  ["replay-mode", "?state=replay"],
];
const viewports = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
for (const [vpName, vp] of Object.entries(viewports)) {
  const page = await browser.newPage({ viewport: vp });
  for (const [slug, params] of shots) {
    let p = params;
    // mobile: evidence panel state uses the segment instead of the side panel
    if (vpName === "mobile" && slug === "thread-resolved-denial-panel") p = "?state=resolved&seg=evidence";
    await page.goto(root + p);
    await page.waitForSelector('html[data-thread-state="settled"]');
    const hscroll = await page.evaluate(() => {
      const el = document.scrollingElement;
      return el.scrollWidth - el.clientWidth;
    });
    if (vp.width === 390 && hscroll > 0) {
      console.error(`FAIL h-scroll ${slug} mobile: overflow ${hscroll}px`);
      process.exitCode = 1;
    }
    await page.screenshot({ path: `${outDir}/${slug}--${vpName}.png` });
    console.log(`ok ${slug}--${vpName} (hscroll=${hscroll})`);
  }
  await page.close();
}
await browser.close();
