import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { IssueChatThread } from "@/components/IssueChatThread";
import { useLiveRunTranscripts, type RunTranscriptSource } from "@/components/transcript/useLiveRunTranscripts";
import { commentsToTaskChatItems } from "@/components/task-chat/task-chat-adapter";
import {
  deriveRunStatusLabel,
  isTerminalRunStatus,
  transcriptToTaskChatItems,
} from "@/components/task-chat/transcript-adapter";
import type { TaskChatItem } from "@/components/task-chat/task-chat-model";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";

export type TaskChatThreadProps = ComponentProps<typeof IssueChatThread>;

/**
 * Task Chat Redesign thread (experimental flag: `enableTaskChatRedesign`).
 *
 * Renders the redesigned, Claude-Code-style thread for the live task. It shares
 * IssueChatThread's exact prop type — so the IssueDetail seam ternary
 * (`redesign ? TaskChatThread : IssueChatThread`) type-checks with no casts.
 *
 * Two data sources feed the render layer, both reused from the existing thread:
 *   - the comment stream (incl. optimistic echoes) → author-typed bubbles, and
 *   - the live run transcript (useLiveRunTranscripts, the same poll+websocket
 *     source the current thread uses) → the in-flight turn streams
 *     thinking → tool → diff → responding, capped by a live "running" status
 *     pill. Only the non-terminal run streams; once it finishes its output
 *     lands as a comment. flag-OFF remains byte-for-byte IssueChatThread.
 */
export function TaskChatThread(props: TaskChatThreadProps) {
  const {
    comments,
    agentMap,
    userLabelMap,
    currentUserId,
    onAdd,
    issueWorkMode = "standard",
    onWorkModeChange,
    composerAccessory,
    footer,
    showComposer = true,
    composerDisabledReason,
    emptyMessage = "No messages yet.",
    companyId,
    linkedRuns,
    liveRuns,
    activeRun,
  } = props;

  const commentItems = useMemo(
    () => commentsToTaskChatItems(comments, { agentMap, userLabelMap, currentUserId }),
    [comments, agentMap, userLabelMap, currentUserId],
  );

  // Every run we might need a transcript for (history + live), deduped by id.
  const runs = useMemo<RunTranscriptSource[]>(() => {
    const map = new Map<string, RunTranscriptSource>();
    for (const r of linkedRuns ?? []) {
      map.set(r.runId, {
        id: r.runId,
        status: r.status,
        adapterType: r.adapterType ?? "",
        hasStoredOutput: r.hasStoredOutput,
        logBytes: r.logBytes,
      });
    }
    for (const r of liveRuns ?? []) {
      map.set(r.id, {
        id: r.id,
        status: r.status,
        adapterType: r.adapterType,
        hasStoredOutput: map.get(r.id)?.hasStoredOutput,
        logBytes: r.logBytes,
        lastOutputBytes: r.lastOutputBytes,
      });
    }
    if (activeRun) {
      map.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        adapterType: activeRun.adapterType,
        logBytes: activeRun.logBytes,
        lastOutputBytes: activeRun.lastOutputBytes,
      });
    }
    return [...map.values()];
  }, [linkedRuns, liveRuns, activeRun]);

  const { transcriptByRun } = useLiveRunTranscripts({ runs, companyId });

  // The single in-flight run whose turn we stream live (non-terminal).
  const liveRun = useMemo(() => {
    if (activeRun && !isTerminalRunStatus(activeRun.status)) return activeRun;
    return (liveRuns ?? []).find((r) => !isTerminalRunStatus(r.status)) ?? null;
  }, [activeRun, liveRuns]);

  // Re-render on a 1s cadence while live so the status pill's elapsed advances
  // even between transcript chunks.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!liveRun) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [liveRun]);

  const items = useMemo<TaskChatItem[]>(() => {
    if (!liveRun) return commentItems;
    const entries = transcriptByRun.get(liveRun.id) ?? [];
    const turn = transcriptToTaskChatItems(entries, {
      runId: liveRun.id,
      agentName: liveRun.agentName,
      running: true,
    });
    const startedAt = liveRun.startedAt ? new Date(liveRun.startedAt).getTime() : null;
    const elapsedMs = startedAt != null ? Math.max(0, Date.now() - startedAt) : undefined;
    const queued = liveRun.status === "queued";
    const status = queued ? { label: "Queued", detail: "Waiting to start" } : deriveRunStatusLabel(entries);
    const statusItem: TaskChatItem = {
      id: `${liveRun.id}:status`,
      kind: "status",
      status: "running",
      label: status.label,
      detail: status.detail,
      elapsedMs,
    };
    return [...commentItems, ...turn, statusItem];
    // `tick` is intentionally a dependency so elapsed advances each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentItems, liveRun, transcriptByRun, tick]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="task-chat-thread">
      <div className="min-h-0 flex-1">
        {items.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <TaskChatThreadView items={items} />
        )}
      </div>
      {showComposer ? (
        <div className="sticky bottom-0 z-10 flex flex-col gap-2 bg-background/80 px-1 pb-2 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          {composerAccessory}
          <TaskChatComposer
            onAdd={onAdd}
            workMode={issueWorkMode}
            onWorkModeChange={onWorkModeChange}
            disabled={Boolean(composerDisabledReason)}
            disabledReason={composerDisabledReason}
          />
          {footer}
        </div>
      ) : null}
    </div>
  );
}
