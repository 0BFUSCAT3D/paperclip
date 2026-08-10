import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  PHASE7_DEFAULT_FIXTURE_PROFILE,
  phase7IssueThreadFixture,
} from "../../../src/issue-thread/fixtures";
import type {
  Phase7EvidenceSectionId,
  Phase7IssueThreadSnapshot,
} from "../../../src/issue-thread/types";
import { phase7DenialCount } from "../../../src/issue-thread/types";
import { Composer } from "./Composer";
import { EvidencePanel } from "./EvidencePanel";
import { IssueHeader } from "./IssueHeader";
import { applyFakeInteractionResponse } from "./fake-store";
import type { Phase7InteractionResponse } from "./InteractionCard";
import { phase7LiveClient, recallSession, rememberSession } from "./live-client";
import { parsePhase7Route, phase7RouteHref, type Phase7Route } from "./route";
import { TurnGroup } from "./ThreadItems";

const PANEL_OPEN_KEY = "paperclip-runner.phase7.panel.open";
const PANEL_WIDTH_KEY = "paperclip-runner.phase7.panel.width";
const PANEL_MIN = 320;
const PANEL_MAX = 640;
const SCENARIOS = ["hb-baseline", "dp-documents", "ix-interactions", "ar-artifacts"];

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, parsed)) : fallback;
  } catch {
    return fallback;
  }
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function useRoute(): Phase7Route {
  const [route, setRoute] = useState(() => parsePhase7Route(window.location));
  useEffect(() => {
    const onChange = () => setRoute(parsePhase7Route(window.location));
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return route;
}

function useLayout(): "side" | "overlay" | "segment" {
  const [layout, setLayout] = useState<"side" | "overlay" | "segment">(() =>
    window.innerWidth <= 767 ? "segment" : window.innerWidth <= 1100 ? "overlay" : "side",
  );
  useEffect(() => {
    const onResize = () =>
      setLayout(window.innerWidth <= 767 ? "segment" : window.innerWidth <= 1100 ? "overlay" : "side");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return layout;
}

export function App() {
  const route = useRoute();
  const layout = useLayout();
  const [snapshot, setSnapshot] = useState<Phase7IssueThreadSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => readStoredFlag(PANEL_OPEN_KEY, false));
  const [panelWidth, setPanelWidth] = useState(() => readStoredNumber(PANEL_WIDTH_KEY, 384));
  const [segment, setSegment] = useState<"thread" | "evidence">(route.segment);
  const [openSections, setOpenSections] = useState<Phase7EvidenceSectionId[]>(["tools"]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | "all">("all");
  const [highlightedRecordId, setHighlightedRecordId] = useState<string | null>(route.record);
  const [focusInteractionId, setFocusInteractionId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [showJump, setShowJump] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cancelResetRef = useRef<HTMLButtonElement | null>(null);

  /* --------------------------------------------------------------- loading */

  useEffect(() => {
    let cancelled = false;
    setSettled(false);
    if (route.mode === "live") {
      void (async () => {
        try {
          const response = await phase7LiveClient.load(recallSession());
          if (cancelled) return;
          rememberSession(response.sessionId);
          setSnapshot(response.view);
        } catch (cause) {
          if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause));
        }
      })();
    } else {
      setSnapshot(phase7IssueThreadFixture(route.shot ?? "thread-baseline", route.fixtureProfile));
    }
    return () => {
      cancelled = true;
    };
  }, [route.mode, route.shot, route.fixtureProfile]);

  /* ------------------------------------------------------- deep-link params */

  useEffect(() => {
    if (route.panel === null) return;
    setPanelOpen(true);
    setSegment("evidence");
    setOpenSections((current) =>
      current.includes(route.panel as Phase7EvidenceSectionId)
        ? current
        : [...current, route.panel as Phase7EvidenceSectionId],
    );
    setHighlightedRecordId(route.record);
  }, [route.panel, route.record]);

  useEffect(() => {
    setSegment(route.segment);
  }, [route.segment]);

  /* -------------------------------------------------- settle + auto-follow */

  useEffect(() => {
    if (snapshot === null) return;
    let cancelled = false;
    const scroller = scrollRef.current;
    void (async () => {
      if (typeof document.fonts?.ready?.then === "function") {
        await document.fonts.ready;
      }
      if (cancelled) return;
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!cancelled) setSettled(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  useEffect(() => {
    if (snapshot === null) return;
    const pending = snapshot.composer.pendingInteractionId;
    if (pending !== null) setAnnouncement("A request is waiting for your answer.");
    else if (snapshot.connection.state === "reconnecting") {
      setAnnouncement(`Connection lost — retrying (attempt ${snapshot.connection.attempt}).`);
    }
  }, [snapshot]);

  /* -------------------------------------------------------------- handlers */

  const persistPanel = useCallback((open: boolean, width: number) => {
    try {
      window.localStorage.setItem(PANEL_OPEN_KEY, String(open));
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {
      // Panel preference is a convenience, never a correctness requirement.
    }
  }, []);

  const openEvidence = useCallback(
    (section: Phase7EvidenceSectionId, recordId: string) => {
      setPanelOpen(true);
      setSegment("evidence");
      setSelectedTurnId("all");
      setOpenSections((current) => (current.includes(section) ? current : [...current, section]));
      setHighlightedRecordId(recordId);
      persistPanel(true, panelWidth);
      window.setTimeout(() => {
        document
          .querySelector(`[data-record-id="${CSS.escape(recordId)}"]`)
          ?.scrollIntoView({ block: "center" });
      }, 0);
    },
    [panelWidth, persistPanel],
  );

  const jumpToThread = useCallback((anchorId: string) => {
    setSegment("thread");
    const anchor = document.getElementById(anchorId) ?? document.querySelector(`#${CSS.escape(anchorId)}`);
    anchor?.scrollIntoView({ block: "center" });
  }, []);

  const respond = useCallback(
    (response: Phase7InteractionResponse) => {
      setSnapshot((current) => {
        if (current === null) return current;
        if (route.mode === "live") {
          void phase7LiveClient
            .respond(current.sessionId, response.interactionId, response.outcome, response.result)
            .then((next) => setSnapshot(next.view))
            .catch((cause) => setError(String(cause)));
          return {
            ...current,
            turns: current.turns.map((turn) => ({
              ...turn,
              items: turn.items.map((item) =>
                item.kind === "interaction" && item.interactionId === response.interactionId
                  ? { ...item, state: "submitting" as const, stateLabel: "Submitting…" }
                  : item,
              ),
            })),
          };
        }
        return applyFakeInteractionResponse(current, response);
      });
      setAnnouncement("Your answer was recorded.");
    },
    [route.mode],
  );

  const send = useCallback(
    (message: string) => {
      setSnapshot((current) => {
        if (current === null) return current;
        if (route.mode === "live") {
          void phase7LiveClient
            .send(current.sessionId, message)
            .then((next) => setSnapshot(next.view))
            .catch((cause) => setError(String(cause)));
          return { ...current, composer: { ...current.composer, state: "sending" } };
        }
        return current;
      });
    },
    [route.mode],
  );

  const stop = useCallback(() => {
    setSnapshot((current) => {
      if (current === null) return current;
      if (route.mode === "live") {
        void phase7LiveClient
          .stop(current.sessionId)
          .then((next) => setSnapshot(next.view))
          .catch((cause) => setError(String(cause)));
        return current;
      }
      const turns = current.turns.map((turn, index) =>
        index === current.turns.length - 1 ? { ...turn, stoppedByUser: true } : turn,
      );
      return {
        ...current,
        turns,
        composer: { state: "ready", helper: null, reason: null, pendingInteractionId: null },
      };
    });
    setAnnouncement("Turn stopped. Partial output is preserved.");
  }, [route.mode]);

  const reset = useCallback(() => {
    setConfirmReset(false);
    if (route.mode === "live" && snapshot !== null) {
      void phase7LiveClient
        .reset(snapshot.sessionId)
        .then((next) => {
          rememberSession(next.sessionId);
          setSnapshot(next.view);
        })
        .catch((cause) => setError(String(cause)));
      return;
    }
    setSnapshot(phase7IssueThreadFixture("thread-baseline", route.fixtureProfile));
    setAnnouncement("Scenario reset. The mock state is back to its clean seed.");
  }, [route.fixtureProfile, route.mode, snapshot]);

  const retry = useCallback(() => {
    if (route.mode === "live" && snapshot !== null) {
      void phase7LiveClient
        .reconnect(snapshot.sessionId)
        .then((next) => setSnapshot(next.view))
        .catch((cause) => setError(String(cause)));
      return;
    }
    setSnapshot((current) =>
      current === null
        ? current
        : {
            ...current,
            connection: { state: "connected", attempt: 0 },
            composer: { state: "ready", helper: null, reason: null, pendingInteractionId: null },
          },
    );
    setReconnected(true);
    window.setTimeout(() => setReconnected(false), 3_000);
  }, [route.mode, snapshot]);

  useEffect(() => {
    if (!confirmReset) return;
    cancelResetRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setConfirmReset(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmReset]);

  /* ---------------------------------------------------------------- render */

  const denialCount = useMemo(
    () => (snapshot === null ? 0 : phase7DenialCount(snapshot.evidence, null)),
    [snapshot],
  );

  if (error !== null) {
    return (
      <main className="pit-app">
        <p className="pit-composer-reason" role="alert">
          {error}
        </p>
      </main>
    );
  }

  if (snapshot === null) {
    return <main className="pit-app" data-thread-state="loading" />;
  }

  const showThread = layout !== "segment" || segment === "thread";
  const showPanel = layout === "segment" ? segment === "evidence" : panelOpen;

  return (
    <div
      className="pit-app"
      data-thread-state={settled ? "settled" : "loading"}
      data-session-mode={snapshot.mode}
      data-connection-state={snapshot.connection.state}
    >
      <IssueHeader
        snapshot={snapshot}
        scenarios={SCENARIOS}
        evidenceOpen={panelOpen}
        denialCount={denialCount}
        segment={segment}
        onToggleEvidence={() => {
          const next = !panelOpen;
          setPanelOpen(next);
          persistPanel(next, panelWidth);
          if (layout === "segment") setSegment(next ? "evidence" : "thread");
        }}
        onSelectScenario={(scenario) => {
          window.location.hash = phase7RouteHref(route, { fixtureProfile: scenario });
        }}
        onReplay={() => {
          window.location.hash = phase7RouteHref(route, {
            shot: "replay-mode",
            mode: "replay",
            at: 12,
          });
        }}
        onReset={() => setConfirmReset(true)}
        onStop={stop}
        onSelectSegment={setSegment}
      />

      {snapshot.connection.state === "reconnecting" ? (
        <p className="pit-banner" role="status" data-testid="reconnect-banner">
          <span aria-hidden="true">⏳</span>
          Connection lost — retrying (attempt {snapshot.connection.attempt})
        </p>
      ) : reconnected ? (
        <p className="pit-banner" data-tone="success" role="status">
          <span aria-hidden="true">✓</span>
          Reconnected
        </p>
      ) : null}

      {snapshot.replay !== null ? (
        <div className="pit-replay-strip" data-testid="replay-strip">
          <span>
            Replay {snapshot.replay.ordinal}/{snapshot.replay.total}
          </span>
          <div
            className="pit-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={snapshot.replay.total}
            aria-valuenow={snapshot.replay.ordinal}
            aria-label="Replay progress"
          >
            <div
              className="pit-progress-fill"
              style={{ width: `${(snapshot.replay.ordinal / snapshot.replay.total) * 100}%` }}
            />
          </div>
          <button
            type="button"
            className="pit-button"
            onClick={() => {
              window.location.hash = phase7RouteHref(route, {
                at: Math.max(0, (route.at ?? snapshot.replay?.ordinal ?? 0) - 1),
              });
            }}
          >
            Step back
          </button>
          <button
            type="button"
            className="pit-button"
            onClick={() => {
              window.location.hash = phase7RouteHref(route, {
                at: (route.at ?? snapshot.replay?.ordinal ?? 0) + 1,
              });
            }}
          >
            Next turn
          </button>
        </div>
      ) : null}

      <div className="pit-body">
        <main className="pit-main" hidden={!showThread}>
          <div className="pit-main-inner">
            <div
              className="pit-thread-scroll"
              ref={scrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const distance =
                  element.scrollHeight - element.scrollTop - element.clientHeight;
                setShowJump(distance > 300);
              }}
            >
              <div className="pit-thread">
                {snapshot.turns.map((turn) => (
                  <TurnGroup
                    key={turn.id}
                    turn={turn}
                    callbacks={{
                      onOpenEvidence: openEvidence,
                      onRespond: respond,
                      focusInteractionId,
                    }}
                  />
                ))}
              </div>
            </div>
            {showJump ? (
              <button
                type="button"
                className="pit-button pit-jump-pill"
                onClick={() => {
                  const element = scrollRef.current;
                  if (element !== null) element.scrollTop = element.scrollHeight;
                  setShowJump(false);
                }}
              >
                Jump to latest
              </button>
            ) : null}
          </div>

          <Composer
            model={snapshot.composer}
            sessionId={snapshot.sessionId}
            onSend={send}
            onStop={stop}
            onRetry={retry}
            onReset={() => setConfirmReset(true)}
            onFocusPending={(interactionId) => {
              setFocusInteractionId(interactionId);
              document
                .getElementById(`interaction-${interactionId}`)
                ?.scrollIntoView({ block: "center" });
            }}
          />
        </main>

        {showPanel && layout === "side" ? (
          <div
            className="pit-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the evidence panel"
            aria-valuemin={PANEL_MIN}
            aria-valuemax={PANEL_MAX}
            aria-valuenow={panelWidth}
            tabIndex={0}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 64 : 16;
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setPanelWidth((current) => {
                  const next = Math.min(PANEL_MAX, current + step);
                  persistPanel(panelOpen, next);
                  return next;
                });
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                setPanelWidth((current) => {
                  const next = Math.max(PANEL_MIN, current - step);
                  persistPanel(panelOpen, next);
                  return next;
                });
              }
            }}
          />
        ) : null}

        {showPanel ? (
          <EvidencePanel
            snapshot={snapshot}
            layout={layout}
            width={panelWidth}
            selectedTurnId={selectedTurnId}
            openSections={openSections}
            highlightedRecordId={highlightedRecordId}
            onSelectTurn={setSelectedTurnId}
            onToggleSection={(section) =>
              setOpenSections((current) =>
                current.includes(section)
                  ? current.filter((entry) => entry !== section)
                  : [...current, section],
              )
            }
            onClose={() => {
              setPanelOpen(false);
              persistPanel(false, panelWidth);
              if (layout === "segment") setSegment("thread");
            }}
            onJumpToThread={jumpToThread}
          />
        ) : null}
      </div>

      {confirmReset ? (
        <div className="pit-dialog-backdrop">
          <div
            className="pit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-dialog-title"
            data-testid="reset-dialog"
          >
            <h2 className="pit-dialog-title" id="reset-dialog-title">
              Reset scenario?
            </h2>
            <p>
              This clears the mock state and starts a clean session. The transcript will be lost.
            </p>
            <div className="pit-button-row">
              <button
                type="button"
                className="pit-button"
                ref={cancelResetRef}
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pit-button"
                data-variant="destructive"
                onClick={reset}
              >
                Reset scenario
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="pit-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
