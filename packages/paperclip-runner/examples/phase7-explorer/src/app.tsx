import * as React from "react";

import { Tabs, type TabDefinition } from "@paperclipai/paperclip-runner/react";
import {
  phase7RunScenario,
  type Phase7EvalSuiteLookup,
  type Phase7ParityStatus,
  type Phase7RunArtifact,
  type Phase7ScenarioIndex,
  type Phase7ScenarioIndexEntry,
} from "@paperclip-runner-local/phase7";

import {
  AuthorizationPanel,
  ContextPanel,
  denialCount,
  ParityPanel,
  StateDiffPanel,
} from "./components/inspector-panels.js";
import { buildFacets, ScenarioPicker, type Phase7PickerFacets } from "./components/scenario-picker.js";
import { RunHeader } from "./components/run-header.js";
import { ScenarioTranscript } from "./components/scenario-transcript.js";
import { EmptyState, Mono } from "./components/primitives.js";
import { DISPOSITION_LABEL } from "./labels.js";
import {
  EMPTY_FILTERS,
  parsePhase7Route,
  serializePhase7Route,
  type Phase7Filters,
  type Phase7InspectorView,
  type Phase7Route,
} from "./route.js";

/**
 * Phase 7 scenario explorer shell.
 *
 * One React tree, three regions: picker (nav), run view (main), inspector
 * (complementary). The shell owns route and view state only — never protocol
 * state, never a policy decision, never a credential.
 */

export interface ExplorerAppProps {
  index: Phase7ScenarioIndex;
  evalSuite?: Phase7EvalSuiteLookup;
  /** Injected so tests can drive a settled state without a live relay probe. */
  codexAvailable?: boolean;
  initialRoute?: Phase7Route;
  /** Test seam: run scenarios synchronously through an injected runner. */
  runScenario?: typeof phase7RunScenario;
}

type RunState = "idle" | "pending" | "settled" | "failed";
type Segment = "scenarios" | "run" | "inspect";

const INSPECTOR_TABS: readonly TabDefinition[] = [
  { id: "context", label: "Context" },
  { id: "authorization", label: "Authorization" },
  { id: "diff", label: "State diff" },
  { id: "parity", label: "Parity" },
];

export function ExplorerApp({
  index,
  evalSuite,
  codexAvailable = false,
  initialRoute,
  runScenario = phase7RunScenario,
}: ExplorerAppProps) {
  const [route, setRoute] = React.useState<Phase7Route>(
    () => initialRoute ?? parsePhase7Route(typeof window === "undefined" ? "#/" : window.location.hash),
  );
  const [artifacts, setArtifacts] = React.useState<Record<string, Phase7RunArtifact>>({});
  const [runState, setRunState] = React.useState<RunState>("idle");
  const [mode, setMode] = React.useState<"fake" | "codex">(route.run ?? "fake");
  const [segment, setSegment] = React.useState<Segment>(() =>
    route.caseId === null ? "scenarios" : route.view === "transcript" ? "run" : "inspect",
  );
  const [replayPosition, setReplayPosition] = React.useState(0);
  const [highlight, setHighlight] = React.useState<number | null>(null);

  const selected = route.caseId === null ? null : findEntry(index, route.caseId);
  const artifact = selected === null ? null : (artifacts[selected.id] ?? null);

  const navigate = React.useCallback((next: Phase7Route) => {
    setRoute(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", serializePhase7Route(next));
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onHashChange = (): void => setRoute(parsePhase7Route(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // A deep link that arrives while the app is already open (hash change, back
  // button) has to move the mobile segment too, or the route says "parity"
  // while the screen still shows the picker.
  React.useEffect(() => {
    setSegment(route.caseId === null ? "scenarios" : route.view === "transcript" ? "run" : "inspect");
  }, [route.caseId, route.view]);

  const run = React.useCallback(
    async (entry: Phase7ScenarioIndexEntry) => {
      setRunState("pending");
      try {
        const next = await runScenario(entry, { mode: "fake", evalSuite });
        setArtifacts((current) => ({ ...current, [entry.id]: next }));
        setReplayPosition(next.timeline.length);
        setRunState(next.failure === null ? "settled" : "failed");
      } catch (error) {
        setRunState("failed");
        throw error;
      }
    },
    [evalSuite, runScenario],
  );

  // `run=fake` auto-executes so a screenshot route settles without interaction.
  React.useEffect(() => {
    if (selected === null || route.run !== "fake") return;
    if (artifacts[selected.id] !== undefined || runState === "pending") return;
    void run(selected);
  }, [artifacts, route.run, run, runState, selected]);

  const parityStatus = React.useCallback(
    (id: string): Phase7ParityStatus => artifacts[id]?.parity.verdict ?? "not_run",
    [artifacts],
  );

  const visible = React.useMemo(
    () => index.entries.filter((entry) => matches(entry, route.filters, parityStatus)),
    [index.entries, parityStatus, route.filters],
  );

  const facets = React.useMemo<Phase7PickerFacets>(
    () =>
      buildFacets(index.entries, (key, value) => {
        const probe: Phase7Filters = {
          ...route.filters,
          [key === "parity" ? "parity" : key]: value,
        };
        return index.entries.filter((entry) => matches(entry, probe, parityStatus)).length;
      }),
    [index.entries, parityStatus, route.filters],
  );

  const timeline = artifact === null ? [] : artifact.timeline.slice(0, replayPosition);
  const settled =
    selected === null
      ? "settled"
      : route.run === null
        ? "settled"
        : runState === "settled" || runState === "failed"
          ? "settled"
          : "pending";

  const view: Phase7InspectorView = route.view;
  const inspectorTab = view === "transcript" ? "context" : view;

  function selectCase(id: string): void {
    navigate({ ...route, caseId: id, filters: route.filters });
    setSegment("run");
    setReplayPosition(artifacts[id]?.timeline.length ?? 0);
  }

  function setView(next: Phase7InspectorView): void {
    navigate({ ...route, view: next });
    if (next !== "transcript") setSegment("inspect");
  }

  function setFilters(patch: Partial<Phase7Filters>): void {
    navigate({ ...route, caseId: null, filters: { ...route.filters, ...patch } });
    setSegment("scenarios");
  }

  return (
    <div
      className="pcr-root pcr7-shell"
      data-run-state={settled}
      data-segment={segment}
      data-testid="explorer-shell"
    >
      <a className="pcr7-skip-link" href="#run-view">
        Skip to run view
      </a>

      {/*
        A radiogroup, not a tablist: the three regions stay landmarks
        (nav / main / complementary) rather than becoming tabpanels, and the
        page keeps exactly one tablist — the inspector's.
      */}
      <div
        className="pcr7-segmented pcr7-segmented--mobile"
        role="radiogroup"
        aria-label="Explorer sections"
      >
        {(["scenarios", "run", "inspect"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={segment === value}
            data-testid={`segment-${value}`}
            onClick={() => setSegment(value)}
          >
            {value === "scenarios" ? "Scenarios" : value === "run" ? "Run" : "Inspect"}
          </button>
        ))}
      </div>

      <div className="pcr7-columns">
        <ScenarioPicker
          entries={index.entries}
          visible={visible}
          facets={facets}
          filters={route.filters}
          selectedId={selected?.id ?? null}
          parityStatus={parityStatus}
          onFilterChange={setFilters}
          onClearFilters={() => setFilters(EMPTY_FILTERS)}
          onSelect={selectCase}
        />

        <main className="pcr7-center" id="run-view" aria-label="Scenario run">
          {selected === null ? (
            <IntroCard index={index} onSelect={selectCase} />
          ) : (
            <>
              <RunHeader
                entry={selected}
                artifact={artifact}
                runState={runState}
                codexAvailable={codexAvailable}
                mode={mode}
                replay={{
                  active: artifact !== null,
                  position: replayPosition,
                  length: artifact?.timeline.length ?? 0,
                  playing: false,
                  enter: () => setReplayPosition(0),
                  exit: () => setReplayPosition(artifact?.timeline.length ?? 0),
                  setPosition: setReplayPosition,
                  togglePlay: () => setReplayPosition(artifact?.timeline.length ?? 0),
                  step: (delta) =>
                    setReplayPosition((current) =>
                      Math.min(Math.max(current + delta, 0), artifact?.timeline.length ?? 0),
                    ),
                }}
                onRun={() => void run(selected)}
                onModeChange={setMode}
                onOpenParity={() => setView("parity")}
              />
              <p className="pcr7-visually-hidden" role="status" aria-live="polite">
                {runState === "settled"
                  ? `Scenario run settled — verdict ${artifact?.parity.verdict ?? "not run"}`
                  : runState === "pending"
                    ? "Scenario run in progress"
                    : ""}
              </p>
              {artifact === null ? (
                <EmptyState title="Run to produce the deterministic timeline.">
                  <p className="pcr7-muted">
                    Fake mode runs entirely in this page against checked-in fixtures. No Paperclip
                    service is contacted and no credential is held.
                  </p>
                </EmptyState>
              ) : (
                <ScenarioTranscript
                  timeline={timeline}
                  highlightSequence={highlight}
                  onSelectSequence={setHighlight}
                />
              )}
            </>
          )}
        </main>

        <aside className="pcr7-inspector" aria-label="Scenario inspector">
          {selected === null ? (
            <CorpusSummary index={index} />
          ) : (
            <Tabs
              items={INSPECTOR_TABS.map((tab) =>
                tab.id === "authorization" && artifact !== null
                  ? {
                      ...tab,
                      label: `Authorization${
                        denialCount(artifact.authorizationRecords) === 0
                          ? ""
                          : ` · ${denialCount(artifact.authorizationRecords)} deny`
                      }`,
                    }
                  : tab,
              )}
              selected={inspectorTab}
              onSelect={(value) => setView(value as Phase7InspectorView)}
              label="Scenario inspector"
            >
              {inspectorTab === "context" ? (
                <ContextPanel entry={selected} artifact={artifact} />
              ) : inspectorTab === "authorization" ? (
                <AuthorizationPanel
                  records={artifact?.authorizationRecords ?? []}
                  onSelectRecord={setHighlight}
                />
              ) : inspectorTab === "diff" ? (
                <StateDiffPanel diff={artifact?.diff ?? null} />
              ) : (
                <ParityPanel parity={artifact?.parity ?? null} />
              )}
            </Tabs>
          )}
        </aside>
      </div>
    </div>
  );
}

function IntroCard({
  index,
  onSelect,
}: {
  index: Phase7ScenarioIndex;
  onSelect: (id: string) => void;
}) {
  const examples = ["hb-scoped-wake-01", "ap-mcp-gate-01", "rs-question-only-01"].filter((id) =>
    index.entries.some((entry) => entry.id === id),
  );
  return (
    <section className="pcr7-intro" data-testid="explorer-intro">
      <p className="pcr-eyebrow">Phase 7 scenario explorer — mock control plane</p>
      <h1>{index.entries.length} scenarios across {index.groups.length} eval groups</h1>
      <p>
        Every scenario runs against the deterministic mock control plane in this page. The explorer
        renders records the runtime produced: it holds no credential, decides no policy, and owns no
        control-plane state.
      </p>
      <p className="pcr7-label">Pick a scenario from the rail, or start here</p>
      <ul className="pcr7-exposure" data-testid="intro-examples">
        {examples.map((id) => (
          <li key={id}>
            <button type="button" className="pcr7-linkish" onClick={() => onSelect(id)}>
              <Mono>{id}</Mono>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The inspector before a scenario is picked. Corpus stats keep the panel
 * useful instead of leaving a dead column (UX map §6, "no dead panels").
 */
function CorpusSummary({ index }: { index: Phase7ScenarioIndex }) {
  const byDisposition = (["control_plane_owned", "always_agent_tool", "optional_agent_tool"] as const).map(
    (disposition) => ({
      disposition,
      label: DISPOSITION_LABEL[disposition],
      count: index.entries.filter((entry) => entry.primaryDisposition === disposition).length,
    }),
  );
  return (
    <div className="pcr7-panel" data-testid="corpus-summary">
      <section className="pcr7-panel-section">
        <h3>Corpus</h3>
        <dl className="pcr7-detail-list">
          <dt>Scenarios</dt>
          <dd>{index.entries.length}</dd>
          <dt>Eval groups</dt>
          <dd>{index.groups.length}</dd>
          {byDisposition.map((row) => (
            <React.Fragment key={row.disposition}>
              <dt>{row.label}</dt>
              <dd>{row.count}</dd>
            </React.Fragment>
          ))}
        </dl>
      </section>
      <section className="pcr7-panel-section">
        <h3>Boundary</h3>
        <p className="pcr7-muted">
          The explorer receives snapshots and records only. It owns no credential, no policy
          decision, and no mutable control-plane state; every allow, deny, and redaction on screen
          was emitted by the mock core.
        </p>
      </section>
      <EmptyState title="Pick a scenario to inspect." />
    </div>
  );
}

function findEntry(index: Phase7ScenarioIndex, id: string): Phase7ScenarioIndexEntry | null {
  return index.entries.find((entry) => entry.id === id) ?? null;
}

export function matches(
  entry: Phase7ScenarioIndexEntry,
  filters: Phase7Filters,
  parityStatus: (id: string) => string,
): boolean {
  if (filters.group !== null && filters.group.length > 0 && entry.group !== filters.group) return false;
  if (
    filters.disposition !== null &&
    filters.disposition.length > 0 &&
    entry.primaryDisposition !== filters.disposition
  ) {
    return false;
  }
  if (filters.role !== null && filters.role.length > 0 && entry.actorRole !== filters.role) return false;
  if (
    filters.claim !== null &&
    filters.claim.length > 0 &&
    !entry.requiredGrants.includes(filters.claim)
  ) {
    return false;
  }
  if (
    filters.parity !== null &&
    filters.parity.length > 0 &&
    parityStatus(entry.id) !== filters.parity
  ) {
    return false;
  }
  if (filters.query.length > 0) {
    const needle = filters.query.toLowerCase();
    if (!`${entry.id} ${entry.title}`.toLowerCase().includes(needle)) return false;
  }
  return true;
}
