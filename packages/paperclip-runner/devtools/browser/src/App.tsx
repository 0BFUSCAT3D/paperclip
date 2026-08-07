import { useMemo, useRef, useState } from "react";

import type { PrpEvent, PrpRequest } from "../../../src/protocol/phase1-contract";
import type { SessionSnapshot } from "../../../src/reducer/session-reducer";
import type {
  Phase2RunMetadata,
  Phase2RunTrace,
  Phase2Scenario,
} from "../../../src/contracts/phase2";
import {
  applyPhase2LiveEvent,
  createPhase2LiveSnapshot,
  phase2SnapshotsMatch,
  replayPhase2Events,
} from "../../../src/tracer/phase2-live";
import { replayPhase1FixtureText } from "../../../src/tracer/phase1-replay";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";

const fixtureFiles = import.meta.glob(
  "../../../protocol/fixtures/phase-01/*.json",
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

const fixtureOrder = [
  "happy-path",
  "failed-run",
  "interrupted-run",
  "duplicate-event",
  "source-gap",
  "unknown-optional-fields",
  "unsupported-required-version",
];

const liveScenarios: Array<{ key: Phase2Scenario; label: string }> = [
  { key: "happy-path", label: "Happy path" },
  { key: "permission-input", label: "Permission and input" },
  { key: "interrupted", label: "Interruption" },
  { key: "error", label: "Scripted error" },
  { key: "duplicate-terminal", label: "Duplicate terminal guard" },
];

interface BrowserFixture {
  key: string;
  label: string;
  source: string;
}

type BrowserMode = "live" | "replay";
type LiveStatus = "idle" | "starting" | "running" | "terminal" | "error";

type Phase2StreamRecord =
  | { kind: "event"; event: unknown }
  | { kind: "diagnostic"; message: string }
  | { kind: "trace"; trace: Phase2RunTrace }
  | { kind: "error"; message: string };

const browserFixtures = Object.entries(fixtureFiles)
  .map(([path, source]): BrowserFixture => {
    const key = path.split("/").at(-1)?.replace(/\.json$/, "") ?? path;
    const parsed = JSON.parse(source) as { name?: string };
    return { key, label: parsed.name ?? key, source };
  })
  .sort((left, right) => fixtureOrder.indexOf(left.key) - fixtureOrder.indexOf(right.key));

function terminalTone(snapshot: SessionSnapshot) {
  if (snapshot.integrity === "gap_detected") {
    return "warning" as const;
  }
  if (snapshot.terminal?.runTerminalState === "succeeded") {
    return "success" as const;
  }
  if (snapshot.terminal?.runTerminalState === "failed") {
    return "danger" as const;
  }
  return "neutral" as const;
}

function SnapshotSummary({
  snapshot,
  label = "Session snapshot",
}: {
  snapshot: SessionSnapshot;
  label?: string;
}) {
  return (
    <>
      <div className="snapshot-heading">
        <div>
          <p className="eyebrow">{label}</p>
          <h2>{snapshot.fixtureName}</h2>
        </div>
        <Badge tone={terminalTone(snapshot)} data-testid="terminal-badge">
          {snapshot.integrity === "gap_detected"
            ? "Gap detected"
            : (snapshot.terminal?.runTerminalState ?? snapshot.runPhase)}
        </Badge>
      </div>

      <dl className="snapshot-grid">
        <div>
          <dt>Run</dt>
          <dd>{snapshot.identity.runId}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{snapshot.identity.normalizedSessionId}</dd>
        </div>
        <div>
          <dt>Turn</dt>
          <dd>{snapshot.terminal?.turnTerminalState ?? snapshot.turnState}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{snapshot.timeline.length}</dd>
        </div>
      </dl>

      {snapshot.proposedResult ? (
        <div className="result-summary" data-testid="result-summary">
          <span>Reported {snapshot.proposedResult.reportedWorkDisposition}</span>
          <p>{snapshot.proposedResult.summary}</p>
        </div>
      ) : null}

      {snapshot.gaps.length > 0 ? (
        <div className="diagnostic" role="status">
          Missing source sequence {snapshot.gaps.flatMap((gap) => gap.missing).join(", ")}.
          Replay remains inspectable but is not complete.
        </div>
      ) : null}

      <div className="timeline-heading">
        <h3>Ordered timeline</h3>
        <span>{snapshot.duplicateEventIds.length} duplicate events ignored</span>
      </div>
      <ol className="timeline" data-testid="timeline">
        {snapshot.timeline.map((event) => (
          <li key={event.sourceEventId}>
            <span className="sequence" aria-hidden="true">
              {event.sourceSeq}
            </span>
            <div>
              <div className="timeline-title">
                <code>{event.eventType}</code>
                <time dateTime={event.emittedAt}>{event.emittedAt.slice(11, 23)}</time>
              </div>
              <p>{event.summary}</p>
            </div>
          </li>
        ))}
      </ol>

      <details className="snapshot-json">
        <summary>Inspect snapshot JSON</summary>
        <pre>{JSON.stringify(snapshot, null, 2)}</pre>
      </details>
    </>
  );
}

function pendingRuntimeRequest(events: readonly PrpEvent[]): PrpRequest | null {
  const resolved = new Set(
    events
      .filter((event) => event.eventType === "runtime_request.resolved")
      .map((event) => (event.payload as Record<string, unknown>).requestId)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const event of events.toReversed()) {
    if (event.eventType !== "runtime_request.created") {
      continue;
    }
    const request = (event.payload as Record<string, unknown>).request;
    if (
      typeof request === "object" &&
      request !== null &&
      "requestId" in request &&
      typeof request.requestId === "string" &&
      !resolved.has(request.requestId)
    ) {
      return request as PrpRequest;
    }
  }
  return null;
}

function LiveRunner() {
  const [scenario, setScenario] = useState<Phase2Scenario>("happy-path");
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [events, setEvents] = useState<PrpEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [input, setInput] = useState("phase-02-live-trace");
  const [trace, setTrace] = useState<Phase2RunTrace | null>(null);
  const [parity, setParity] = useState<boolean | null>(null);
  const snapshotRef = useRef<SessionSnapshot | null>(null);
  const eventsRef = useRef<PrpEvent[]>([]);

  const request = useMemo(() => pendingRuntimeRequest(events), [events]);

  async function startRun() {
    setStatus("starting");
    setError(null);
    setDiagnostic(null);
    setTrace(null);
    setParity(null);
    setRunId(null);
    setEvents([]);
    eventsRef.current = [];
    setSnapshot(null);
    snapshotRef.current = null;

    try {
      const startResponse = await fetch("/api/phase2/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const started = (await startResponse.json()) as {
        id?: string;
        metadata?: Phase2RunMetadata;
        error?: string;
      };
      if (!startResponse.ok || started.id === undefined || started.metadata === undefined) {
        throw new Error(started.error ?? "The local runner did not start.");
      }
      setRunId(started.id);
      const initial = createPhase2LiveSnapshot(started.metadata);
      setSnapshot(initial);
      snapshotRef.current = initial;
      setStatus("running");

      const streamResponse = await fetch(`/api/phase2/runs/${started.id}/events`);
      if (!streamResponse.ok || streamResponse.body === null) {
        throw new Error("The live event stream did not open.");
      }
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const part = await reader.read();
        buffered += decoder.decode(part.value, { stream: !part.done });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length > 0) {
            handleRecord(JSON.parse(line) as Phase2StreamRecord, started.metadata);
          }
        }
        if (part.done) {
          if (buffered.trim().length > 0) {
            handleRecord(JSON.parse(buffered) as Phase2StreamRecord, started.metadata);
          }
          break;
        }
      }
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function handleRecord(record: Phase2StreamRecord, metadata: Phase2RunMetadata) {
    if (record.kind === "event") {
      const current = snapshotRef.current;
      if (current === null) {
        return;
      }
      const applied = applyPhase2LiveEvent(current, record.event);
      if (!applied.ok) {
        setStatus("error");
        setError(applied.issues.join("; "));
        return;
      }
      snapshotRef.current = applied.snapshot;
      setSnapshot(applied.snapshot);
      eventsRef.current = [...eventsRef.current, applied.event];
      setEvents(eventsRef.current);
      return;
    }
    if (record.kind === "diagnostic") {
      setDiagnostic(record.message);
      return;
    }
    if (record.kind === "error") {
      setStatus("error");
      setError(record.message);
      return;
    }
    setTrace(record.trace);
    const replay = replayPhase2Events(metadata, record.trace.events);
    setParity(
      snapshotRef.current === null
        ? false
        : phase2SnapshotsMatch(snapshotRef.current, replay),
    );
    setStatus("terminal");
  }

  async function postAction(action: "interrupt" | "resolve", body?: unknown) {
    if (runId === null) {
      return;
    }
    const response = await fetch(`/api/phase2/runs/${runId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
      const failure = (await response.json()) as { error?: string };
      setError(failure.error ?? `The ${action} command failed.`);
      setStatus("error");
    }
  }

  return (
    <div className="workspace-grid live-workspace">
      <Card aria-labelledby="live-controls-title">
        <CardHeader>
          <CardTitle id="live-controls-title">Local runner controls</CardTitle>
          <CardDescription>
            Start one Rust runner and one scripted fake harness. No network or model is used.
          </CardDescription>
        </CardHeader>
        <CardContent className="editor-content">
          <label htmlFor="live-scenario">Scenario</label>
          <select
            id="live-scenario"
            value={scenario}
            disabled={status === "starting" || status === "running"}
            onChange={(event) => setScenario(event.target.value as Phase2Scenario)}
          >
            {liveScenarios.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </select>
          <div className="scenario-actions">
            <Button
              type="button"
              disabled={status === "starting" || status === "running"}
              onClick={() => void startRun()}
            >
              {status === "starting" ? "Starting…" : "Start local run"}
            </Button>
            <Button
              type="button"
              disabled={status !== "running" || snapshot?.turnState !== "running"}
              onClick={() => void postAction("interrupt")}
            >
              Interrupt turn
            </Button>
          </div>

          <div className="live-status" aria-live="polite">
            <span>Runner status</span>
            <Badge
              tone={status === "error" ? "danger" : status === "terminal" ? "success" : "neutral"}
              data-testid="live-status"
            >
              {status}
            </Badge>
          </div>

          {request?.requestKind === "runtime" ? (
            <div className="request-card" data-testid="runtime-request">
              <div>
                <p className="eyebrow">{request.type} request</p>
                <p>{request.prompt}</p>
              </div>
              {request.type === "permission" ? (
                <Button
                  type="button"
                  onClick={() =>
                    void postAction("resolve", {
                      requestId: request.requestId,
                      response: { decision: "allow" },
                    })
                  }
                >
                  Allow
                </Button>
              ) : (
                <>
                  <label htmlFor="runtime-input">Response</label>
                  <input
                    id="runtime-input"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                  />
                  <Button
                    type="button"
                    disabled={input.trim().length === 0}
                    onClick={() =>
                      void postAction("resolve", {
                        requestId: request.requestId,
                        response: { text: input },
                      })
                    }
                  >
                    Send input
                  </Button>
                </>
              )}
            </div>
          ) : null}

          {trace?.harnessProcessExit ? (
            <dl className="process-facts" data-testid="process-facts">
              <div>
                <dt>Harness process exit</dt>
                <dd>{trace.harnessProcessExit.exitCode ?? "signal"}</dd>
              </div>
              <div>
                <dt>Semantic result</dt>
                <dd>{trace.result?.reportedWorkDisposition ?? "missing"}</dd>
              </div>
            </dl>
          ) : null}

          {parity !== null ? (
            <div className="parity-line" data-testid="parity-result">
              <span>Live and replay reducer output</span>
              <Badge tone={parity ? "success" : "danger"}>
                {parity ? "Match" : "Mismatch"}
              </Badge>
            </div>
          ) : null}
          {diagnostic ? <p className="diagnostic">{diagnostic}</p> : null}
          {error ? <p className="validation-errors" role="alert">{error}</p> : null}
        </CardContent>
      </Card>

      <section className="replay-panel" aria-live="polite">
        {snapshot ? (
          <SnapshotSummary snapshot={snapshot} label="Validated live snapshot" />
        ) : (
          <div className="empty-live-state">
            <p className="eyebrow">Validated live snapshot</p>
            <h2>Start a local run</h2>
            <p>Each incoming event will pass the Phase 1 validator before the reducer applies it.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function StaticReplay() {
  const defaultFixture = browserFixtures[0];
  if (defaultFixture === undefined) {
    throw new Error("No Phase 1 fixtures were bundled");
  }
  const [selectedFixture, setSelectedFixture] = useState(defaultFixture.key);
  const [source, setSource] = useState(defaultFixture.source);
  const [replay, setReplay] = useState(() => replayPhase1FixtureText(defaultFixture.source));
  const selected = useMemo(
    () => browserFixtures.find((fixture) => fixture.key === selectedFixture),
    [selectedFixture],
  );

  function chooseFixture(key: string) {
    const fixture = browserFixtures.find((candidate) => candidate.key === key);
    if (fixture === undefined) {
      return;
    }
    setSelectedFixture(key);
    setSource(fixture.source);
    setReplay(replayPhase1FixtureText(fixture.source));
  }

  return (
    <div className="workspace-grid">
      <Card aria-labelledby="fixture-editor-title">
        <CardHeader>
          <CardTitle id="fixture-editor-title">Fixture input</CardTitle>
          <CardDescription>
            Choose a conformance case or edit the JSON, then validate and replay it.
          </CardDescription>
        </CardHeader>
        <CardContent className="editor-content">
          <label htmlFor="fixture-select">Fixture</label>
          <select
            id="fixture-select"
            value={selectedFixture}
            onChange={(event) => chooseFixture(event.target.value)}
          >
            {browserFixtures.map((fixture) => (
              <option key={fixture.key} value={fixture.key}>
                {fixture.label}
              </option>
            ))}
          </select>
          <label htmlFor="fixture-source">PRP JSON</label>
          <Textarea
            id="fixture-source"
            spellCheck={false}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <div className="editor-actions">
            <span>{selected?.label ?? "Edited fixture"}</span>
            <Button type="button" onClick={() => setReplay(replayPhase1FixtureText(source))}>
              Validate &amp; replay
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="replay-panel" aria-live="polite">
        {replay.ok ? (
          <SnapshotSummary snapshot={replay.snapshot} label="Static replay snapshot" />
        ) : (
          <div className="validation-errors" role="alert">
            <Badge tone="danger">Validation failed</Badge>
            <h2>Fixture cannot be replayed</h2>
            <ul>
              {replay.issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`}>
                  <code>{issue.path}</code> — {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

export function App() {
  const [mode, setMode] = useState<BrowserMode>("live");

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Paperclip Runner Protocol · Phase 2</p>
          <h1>Live local runner</h1>
          <p>
            Run the Rust supervisor and fake harness, then compare the live state with replay.
          </p>
        </div>
        <Badge tone="neutral">Standalone · no Paperclip core</Badge>
      </header>

      <nav className="mode-switch" aria-label="Runner devtool mode">
        <Button
          type="button"
          aria-pressed={mode === "live"}
          onClick={() => setMode("live")}
        >
          Live runner
        </Button>
        <Button
          type="button"
          aria-pressed={mode === "replay"}
          onClick={() => setMode("replay")}
        >
          Static replay
        </Button>
      </nav>

      {mode === "live" ? <LiveRunner /> : <StaticReplay />}
    </main>
  );
}
