// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, IssueRecoveryAction } from "@paperclipai/shared";
import { vi } from "vitest";
import { RecoveryProgressLine } from "./RecoveryProgressLine";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const ctoAgent = {
  id: "33333333-3333-3333-3333-333333333333",
  companyId: "company-1",
  name: "CTO",
  role: "cto",
  status: "working",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  permissions: {},
  urlKey: "cto",
} as unknown as Agent;

function buildAction(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "00000000-0000-0000-0000-0000000000ab",
    companyId: "company-1",
    sourceIssueId: "00000000-0000-0000-0000-0000000000fe",
    recoveryIssueId: null,
    kind: "stranded_assigned_issue",
    status: "active",
    ownerType: "agent",
    ownerAgentId: ctoAgent.id,
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "stranded_assigned_issue",
    fingerprint: "fp",
    evidence: { summary: "The last run stopped without a disposition." },
    nextAction: "Choose what happens next.",
    wakePolicy: { type: "wake_owner" },
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: null,
    lastAttemptAt: null,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    ...overrides,
  };
}

const agentMap = new Map<string, Agent>([[ctoAgent.id, ctoAgent]]);

describe("RecoveryProgressLine", () => {
  it("renders a recessed line naming the live recovery owner", () => {
    const host = render(
      <RecoveryProgressLine state="in_progress" action={buildAction()} agentMap={agentMap} />,
    );
    const line = host.querySelector('[data-testid="recovery-progress-line"]');
    expect(line?.getAttribute("data-recovery-state")).toBe("in_progress");
    expect(host.textContent).toContain("Recovery in progress · CTO");
    expect(host.textContent).not.toContain("Recovery needed");
  });

  it("prefers an explicitly supplied owner name over the agent map", () => {
    const host = render(
      <RecoveryProgressLine
        state="in_progress"
        ownerName="Ops"
        action={buildAction()}
        agentMap={agentMap}
      />,
    );
    expect(host.textContent).toContain("Recovery in progress · Ops");
  });

  it("labels the observe-only state without an owner suffix", () => {
    const host = render(
      <RecoveryProgressLine state="observe_only" action={buildAction()} agentMap={agentMap} />,
    );
    expect(host.textContent).toContain("Observing active run");
    expect(host.textContent).not.toContain("· CTO");
  });

  it("keeps the details folded until the line is toggled", () => {
    const host = render(
      <RecoveryProgressLine state="in_progress" action={buildAction()} agentMap={agentMap} />,
    );
    const toggle = host.querySelector('[data-testid="recovery-progress-line-toggle"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-testid="recovery-progress-line-details"]')).toBeNull();

    click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const details = host.querySelector('[data-testid="recovery-progress-line-details"]');
    expect(details).not.toBeNull();
    // Evidence stays inspectable — exactly one recovery card, in the recessed tone.
    const cards = host.querySelectorAll("[data-recovery-state][role='status']");
    expect(cards.length).toBe(1);
    expect(cards[0]?.getAttribute("data-recovery-state")).toBe("in_progress");

    click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-testid="recovery-progress-line-details"]')).toBeNull();
  });

  it("opens expanded when asked", () => {
    const host = render(
      <RecoveryProgressLine
        state="in_progress"
        defaultOpen
        action={buildAction()}
        agentMap={agentMap}
      />,
    );
    expect(host.querySelector('[data-testid="recovery-progress-line-details"]')).not.toBeNull();
  });

  it("exposes the disclosure to the keyboard as a native, focusable button", () => {
    const host = render(
      <RecoveryProgressLine state="in_progress" action={buildAction()} agentMap={agentMap} />,
    );
    const toggle = host.querySelector<HTMLButtonElement>(
      '[data-testid="recovery-progress-line-toggle"]',
    );
    expect(toggle?.tagName).toBe("BUTTON");
    expect(toggle?.getAttribute("type")).toBe("button");
    // aria-controls must point at the panel it reveals, once revealed.
    const controls = toggle?.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(toggle?.className).toContain("focus-visible:ring-2");

    act(() => toggle?.focus());
    expect(document.activeElement).toBe(toggle);

    click(toggle);
    const panel = host.querySelector('[data-testid="recovery-progress-line-details"]');
    expect(panel?.id).toBe(controls);
  });

  it("uses theme tokens instead of prominent amber/red treatment", () => {
    const host = render(
      <RecoveryProgressLine
        state="in_progress"
        defaultOpen
        action={buildAction()}
        agentMap={agentMap}
      />,
    );
    const toggle = host.querySelector('[data-testid="recovery-progress-line-toggle"]');
    expect(toggle?.className).toContain("text-muted-foreground");
    expect(toggle?.className).not.toMatch(/amber|red|sky/);
    const card = host.querySelector("[data-recovery-state][role='status']");
    // Light and dark both resolve from the muted token pair — no per-theme literals.
    expect(card?.className).not.toMatch(/amber|red|sky/);
    expect(card?.className).toContain("bg-muted/40");
    expect(card?.className).toContain("dark:bg-muted/20");
  });

  it("stays legible on narrow viewports", () => {
    const host = render(
      <RecoveryProgressLine state="in_progress" action={buildAction()} agentMap={agentMap} />,
    );
    const toggle = host.querySelector('[data-testid="recovery-progress-line-toggle"]');
    expect(toggle?.className).toContain("min-w-0");
    const label = toggle?.querySelector("span");
    expect(label?.className).toContain("truncate");
    // The "Details" hint is desktop-only so the owner name keeps the mobile row.
    const hint = toggle?.querySelectorAll("span")[1];
    expect(hint?.className).toContain("hidden");
    expect(hint?.className).toContain("sm:inline");
  });
});
