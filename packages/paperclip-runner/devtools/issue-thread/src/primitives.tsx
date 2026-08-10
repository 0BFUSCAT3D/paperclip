import type { ReactNode } from "react";

import type { Phase7TaskStatus } from "../../../src/mock-core/phase7-control-plane-types";

/**
 * Package-local equivalents of the product StatusBadge/chip anatomy. Every
 * state pairs color with a glyph and text so the surface stays readable
 * without color (contract §9.5).
 */

const STATUS_COPY: Record<Phase7TaskStatus, { label: string; glyph: string }> = {
  backlog: { label: "Backlog", glyph: "○" },
  todo: { label: "Todo", glyph: "○" },
  in_progress: { label: "In progress", glyph: "◐" },
  in_review: { label: "In review", glyph: "◑" },
  done: { label: "Done", glyph: "✓" },
  blocked: { label: "Blocked", glyph: "✕" },
  cancelled: { label: "Cancelled", glyph: "–" },
};

const PRIORITY_GLYPH: Record<string, string> = {
  critical: "▲▲",
  high: "▲",
  medium: "▬",
  low: "▼",
};

export function StatusBadge({ status }: { status: Phase7TaskStatus }) {
  const copy = STATUS_COPY[status];
  return (
    <span className="pit-status-badge" data-status={status}>
      <span aria-hidden="true">{copy.glyph}</span>
      {copy.label}
    </span>
  );
}

export function PriorityIcon({ priority }: { priority: string }) {
  return (
    <span className="pit-priority">
      <span aria-hidden="true">{PRIORITY_GLYPH[priority] ?? "▬"}</span>{" "}
      {priority.charAt(0).toUpperCase() + priority.slice(1)} priority
    </span>
  );
}

export function Chip({
  tone,
  children,
  title,
  testId,
}: {
  tone?: "live" | "mock" | "accent" | "success" | "danger";
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <span className="pit-chip" data-tone={tone} title={title} data-testid={testId}>
      {children}
    </span>
  );
}

export function Timestamp({ value }: { value: string }) {
  // Rendered from fixture data with a fixed locale so captures stay stable.
  const stamp = new Date(value);
  const hours = String(stamp.getUTCHours()).padStart(2, "0");
  const minutes = String(stamp.getUTCMinutes()).padStart(2, "0");
  const seconds = String(stamp.getUTCSeconds()).padStart(2, "0");
  return (
    <time className="pit-card-meta" dateTime={value}>
      {hours}:{minutes}:{seconds}
    </time>
  );
}

export function formatBytes(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} kB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}
