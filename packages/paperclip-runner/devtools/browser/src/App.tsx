import { useMemo, useState } from "react";

import { replayPhase1FixtureText } from "../../../src/tracer/phase1-replay";
import type { SessionSnapshot } from "../../../src/reducer/session-reducer";
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

interface BrowserFixture {
  key: string;
  label: string;
  source: string;
}

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

function SnapshotSummary({ snapshot }: { snapshot: SessionSnapshot }) {
  return (
    <>
      <div className="snapshot-heading">
        <div>
          <p className="eyebrow">Final session snapshot</p>
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

export function App() {
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
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Paperclip Runner Protocol · Phase 1</p>
          <h1>Static session replay</h1>
          <p>
            Validate an editable PRP fixture and reduce its ordered events with the same
            contract used by the CLI.
          </p>
        </div>
        <Badge tone="neutral">Standalone · no Paperclip core</Badge>
      </header>

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
            <SnapshotSummary snapshot={replay.snapshot} />
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
    </main>
  );
}
