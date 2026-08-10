import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mockupUrl = new URL("./phase-7-issue-thread.html", import.meta.url);
const captureUrl = new URL("./capture-issue-thread-mockup.mjs", import.meta.url);

test("the capture recipe covers implemented mockup states and contract viewports", async () => {
  const [mockup, capture] = await Promise.all([
    readFile(mockupUrl, "utf8"),
    readFile(captureUrl, "utf8"),
  ]);

  const capturedStates = [
    ...capture.matchAll(/\?state=([a-z-]+)/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    [...new Set(capturedStates)],
    ["pending", "baseline", "resolved", "streaming", "replay"],
  );
  for (const state of capturedStates) {
    if (state === "pending") {
      assert.match(mockup, /id="pendingcard"/);
      continue;
    }
    assert.match(mockup, new RegExp(`state === '${state}'`));
  }

  assert.match(capture, /desktop: \{ width: 1440, height: 900 \}/);
  assert.match(capture, /mobile: \{ width: 390, height: 844 \}/);
  assert.match(capture, /p = "\?state=resolved&seg=evidence"/);
  assert.match(capture, /vp\.width === 390 && hscroll > 0/);
  assert.match(mockup, /data-thread-state="pending"/);
  assert.match(mockup, /dataset\.threadState = 'settled'/);
});
