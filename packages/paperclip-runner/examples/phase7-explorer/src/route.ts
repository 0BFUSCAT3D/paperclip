/**
 * Hash routing for the Phase 7 scenario explorer.
 *
 * Static hosting means no server rewrites, so every linkable view lives in the
 * hash (UX map §7). Filter state mirrors into the route so any filtered picker
 * view is shareable; it is never protocol state.
 */

export type Phase7InspectorView = "transcript" | "context" | "authorization" | "diff" | "parity";

export const PHASE7_INSPECTOR_VIEWS: readonly Phase7InspectorView[] = [
  "transcript",
  "context",
  "authorization",
  "diff",
  "parity",
];

export interface Phase7Filters {
  group: string | null;
  disposition: string | null;
  role: string | null;
  claim: string | null;
  parity: string | null;
  query: string;
}

export interface Phase7Route {
  caseId: string | null;
  run: "fake" | "codex" | null;
  view: Phase7InspectorView;
  filters: Phase7Filters;
}

export const EMPTY_FILTERS: Phase7Filters = {
  group: null,
  disposition: null,
  role: null,
  claim: null,
  parity: null,
  query: "",
};

export function parsePhase7Route(hash: string): Phase7Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const params = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  const caseId = segments[0] === "case" && segments[1] !== undefined ? decodeURIComponent(segments[1]) : null;
  const run = params.get("run");
  const view = params.get("view");
  return {
    caseId,
    run: run === "fake" || run === "codex" ? run : null,
    view: isInspectorView(view) ? view : "transcript",
    filters: {
      group: params.get("group"),
      disposition: params.get("disposition"),
      role: params.get("role"),
      claim: params.get("claim"),
      parity: params.get("parity"),
      query: params.get("q") ?? "",
    },
  };
}

export function serializePhase7Route(route: Phase7Route): string {
  const params = new URLSearchParams();
  if (route.run !== null) params.set("run", route.run);
  if (route.view !== "transcript") params.set("view", route.view);
  if (route.caseId === null) {
    for (const [key, value] of [
      ["group", route.filters.group],
      ["disposition", route.filters.disposition],
      ["role", route.filters.role],
      ["claim", route.filters.claim],
      ["parity", route.filters.parity],
    ] as const) {
      if (value !== null && value.length > 0) params.set(key, value);
    }
    if (route.filters.query.length > 0) params.set("q", route.filters.query);
  }
  const path = route.caseId === null ? "/" : `/case/${encodeURIComponent(route.caseId)}`;
  const query = params.toString();
  return `#${path}${query.length > 0 ? `?${query}` : ""}`;
}

export function activeFilterChips(
  filters: Phase7Filters,
): Array<{ key: keyof Phase7Filters; label: string; value: string }> {
  const chips: Array<{ key: keyof Phase7Filters; label: string; value: string }> = [];
  if (filters.group !== null && filters.group.length > 0) {
    chips.push({ key: "group", label: "Group", value: filters.group });
  }
  if (filters.disposition !== null && filters.disposition.length > 0) {
    chips.push({ key: "disposition", label: "Disposition", value: filters.disposition });
  }
  if (filters.role !== null && filters.role.length > 0) {
    chips.push({ key: "role", label: "Role", value: filters.role });
  }
  if (filters.claim !== null && filters.claim.length > 0) {
    chips.push({ key: "claim", label: "Claim", value: filters.claim });
  }
  if (filters.parity !== null && filters.parity.length > 0) {
    chips.push({ key: "parity", label: "Parity", value: filters.parity });
  }
  if (filters.query.length > 0) {
    chips.push({ key: "query", label: "Search", value: filters.query });
  }
  return chips;
}

export function hasActiveFilters(filters: Phase7Filters): boolean {
  return activeFilterChips(filters).length > 0;
}

function isInspectorView(value: string | null): value is Phase7InspectorView {
  return value !== null && (PHASE7_INSPECTOR_VIEWS as readonly string[]).includes(value);
}
