/**
 * Deterministic route scheme from the Phase 7B UX contract §10.1.
 *
 * `#/issue/<fixtureProfile>?shot=<slug>&panel=<section>&rec=<id>&at=<ordinal>&seg=thread|evidence`
 *
 * Parameters are also accepted on the document query string so a capture tool
 * can address a state without depending on hash-fragment escaping.
 */

import type { Phase7EvidenceSectionId } from "../../../src/issue-thread/types";
import { PHASE7_EVIDENCE_SECTIONS } from "../../../src/issue-thread/types";
import { PHASE7_DEFAULT_FIXTURE_PROFILE } from "../../../src/issue-thread/fixtures";

export interface Phase7Route {
  fixtureProfile: string;
  shot: string | null;
  panel: Phase7EvidenceSectionId | null;
  record: string | null;
  at: number | null;
  segment: "thread" | "evidence";
  /** `live` opts into the package session server; otherwise fixtures render. */
  mode: "fake" | "live" | "replay";
}

const SECTION_IDS = new Set<string>(PHASE7_EVIDENCE_SECTIONS.map((section) => section.id));

function mergeParams(search: string, hash: string): URLSearchParams {
  const params = new URLSearchParams(search);
  const queryIndex = hash.indexOf("?");
  if (queryIndex >= 0) {
    for (const [key, value] of new URLSearchParams(hash.slice(queryIndex + 1))) {
      params.set(key, value);
    }
  }
  return params;
}

export function parsePhase7Route(url: {
  search: string;
  hash: string;
}): Phase7Route {
  const params = mergeParams(url.search, url.hash);
  const path = url.hash.replace(/^#/, "").split("?")[0] ?? "";
  const match = /^\/issue\/([^/?]+)/.exec(path);
  const shot = params.get("shot");
  const requestedMode = params.get("mode");
  const panel = params.get("panel");
  const at = params.get("at");
  const segment = params.get("seg");
  const mode =
    requestedMode === "live" || requestedMode === "replay" || requestedMode === "fake"
      ? requestedMode
      : shot === "replay-mode"
        ? "replay"
        : "fake";
  return {
    fixtureProfile: match?.[1] ?? PHASE7_DEFAULT_FIXTURE_PROFILE,
    shot,
    panel: panel !== null && SECTION_IDS.has(panel) ? (panel as Phase7EvidenceSectionId) : null,
    record: params.get("rec"),
    at: at !== null && /^\d+$/.test(at) ? Number.parseInt(at, 10) : null,
    segment: segment === "evidence" ? "evidence" : "thread",
    mode,
  };
}

export function phase7RouteHref(route: Phase7Route, overrides: Partial<Phase7Route>): string {
  const next = { ...route, ...overrides };
  const params = new URLSearchParams();
  if (next.shot !== null) params.set("shot", next.shot);
  if (next.mode !== "fake") params.set("mode", next.mode);
  if (next.panel !== null) params.set("panel", next.panel);
  if (next.record !== null) params.set("rec", next.record);
  if (next.at !== null) params.set("at", String(next.at));
  if (next.segment !== "thread") params.set("seg", next.segment);
  const query = params.toString();
  return `#/issue/${next.fixtureProfile}${query.length > 0 ? `?${query}` : ""}`;
}
