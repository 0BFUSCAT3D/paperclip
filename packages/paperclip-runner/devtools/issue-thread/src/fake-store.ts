import type {
  Phase7IssueThreadSnapshot,
  Phase7ThreadInteractionState,
  Phase7ThreadItem,
} from "../../../src/issue-thread/types";
import type { Phase7InteractionResponse } from "./InteractionCard";

/**
 * `fake`-mode interaction store.
 *
 * The screenshot matrix runs without a session server, so this module plays
 * the mock control plane's role for the deterministic fixtures only: it stores
 * the response and then hands back a new snapshot, mirroring the live authority
 * path (store first, resume second) rather than resolving the card optimistically
 * in the card component. Live mode never reaches this code — it posts to the
 * package server instead.
 */

function resolvedState(
  outcome: Phase7InteractionResponse["outcome"],
): { state: Phase7ThreadInteractionState; label: string } {
  if (outcome === "accepted") return { state: "accepted", label: "Accepted" };
  if (outcome === "rejected") return { state: "rejected", label: "Changes requested" };
  return { state: "answered", label: "Answered" };
}

function summarise(response: Phase7InteractionResponse): string[] {
  const result = response.result;
  if (Array.isArray(result.selected)) return result.selected.map((entry) => String(entry));
  if (Array.isArray(result.acceptedTaskIds)) {
    return result.acceptedTaskIds.map((entry) => `Accepted ${String(entry)}`);
  }
  if (Array.isArray(result.verdicts)) {
    return result.verdicts.map((entry) => {
      const verdict = entry as { id?: unknown; verdict?: unknown };
      return `${String(verdict.id)} — ${String(verdict.verdict)}`;
    });
  }
  if (typeof result.answers === "object" && result.answers !== null) {
    return Object.entries(result.answers as Record<string, unknown>).map(
      ([key, value]) => `${key} — ${String(value)}`,
    );
  }
  if (result.accepted === true) return ["Accepted"];
  return [];
}

function applyToItem(
  item: Phase7ThreadItem,
  response: Phase7InteractionResponse,
): Phase7ThreadItem {
  if (item.kind !== "interaction" || item.interactionId !== response.interactionId) return item;
  const view = resolvedState(response.outcome);
  return {
    ...item,
    state: view.state,
    stateLabel: view.label,
    resolvedSummary: summarise(response),
    reason: typeof response.result.reason === "string" ? response.result.reason : null,
  };
}

/** Store the typed response, then return the snapshot the card renders from. */
export function applyFakeInteractionResponse(
  snapshot: Phase7IssueThreadSnapshot,
  response: Phase7InteractionResponse,
): Phase7IssueThreadSnapshot {
  const turns = snapshot.turns.map((turn) => ({
    ...turn,
    items: turn.items.map((item) => applyToItem(item, response)),
  }));
  const stillPending = turns.some(
    (turn) => turn.items.some((item) => item.kind === "interaction" && item.state === "pending"),
  );
  return {
    ...snapshot,
    turns,
    composer: stillPending
      ? snapshot.composer
      : { state: "ready", helper: null, reason: null, pendingInteractionId: null },
  };
}
