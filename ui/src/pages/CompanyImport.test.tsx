// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanyPortabilityImportResult, CompanyPortabilityPreviewResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyImport } from "./CompanyImport";

const mockCompaniesApi = vi.hoisted(() => ({
  importPreview: vi.fn(),
  importBundle: vi.fn(),
  get: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  resume: vi.fn(),
}));
const mockRoutinesApi = vi.hoisted(() => ({
  update: vi.fn(),
}));
const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const mockSidebarPreferencesApi = vi.hoisted(() => ({
  updateProjectOrder: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockReadZipArchive = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../lib/zip", () => ({
  readZipArchive: mockReadZipArchive,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/routines", () => ({
  routinesApi: mockRoutinesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/sidebarPreferences", () => ({
  sidebarPreferencesApi: mockSidebarPreferencesApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
  useOptionalCompany: () => null,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// MarkdownEditor pulls in @mdxeditor/editor, whose sandpack dependency inserts
// CSS rules jsdom cannot parse; the editor is never exercised by these tests.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value?: string }) => <textarea readOnly value={value ?? ""} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const previewFiles = {
  ".paperclip.yaml": 'schema: "paperclip/v1"\n',
  "agents/coder/AGENTS.md": "---\nname: Coder\n---\n\nYou write code.\n",
  "tasks/weekly-report/TASK.md": "---\nname: Weekly Report\nrecurring: true\n---\n\nSend the report.\n",
};

function buildPreviewResult(): CompanyPortabilityPreviewResult {
  return {
    include: { company: true, agents: true, projects: true, issues: true },
    targetCompanyId: null,
    targetCompanyName: null,
    collisionStrategy: "rename",
    selectedAgentSlugs: ["coder"],
    plan: {
      companyAction: "create",
      agentPlans: [{ slug: "coder", action: "create", plannedName: "Coder", existingAgentId: null, reason: null }],
      projectPlans: [],
      issuePlans: [{ slug: "weekly-report", action: "create", plannedTitle: "Weekly Report", reason: "Recurring task will be imported as a routine." }],
    },
    manifest: {
      agents: [{ slug: "coder", name: "Coder", path: "agents/coder/AGENTS.md", adapterType: "claude_local" }],
      projects: [],
      issues: [{ slug: "weekly-report", title: "Weekly Report", path: "tasks/weekly-report/TASK.md" }],
      skills: [],
      company: null,
    },
    files: previewFiles,
    envInputs: [],
    warnings: [],
    errors: [],
  } as unknown as CompanyPortabilityPreviewResult;
}

function buildImportResult(): CompanyPortabilityImportResult {
  return {
    company: { id: "company-2", name: "Imported Test", action: "created" },
    agents: [{ slug: "coder", id: "agent-1", action: "created", name: "Coder", reason: null }],
    projects: [],
    routines: [{ slug: "weekly-report", id: "routine-1", action: "created", title: "Weekly Report", status: "paused" }],
    envInputs: [],
    warnings: [],
  };
}

describe("CompanyImport", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.resume.mockResolvedValue({ id: "agent-1", status: "idle" });
    mockRoutinesApi.update.mockResolvedValue({ id: "routine-1", status: "active" });
    mockCompaniesApi.importPreview.mockResolvedValue(buildPreviewResult());
    mockCompaniesApi.importBundle.mockResolvedValue(buildImportResult());
    mockCompaniesApi.get.mockResolvedValue({ id: "company-2", name: "Imported Test", issuePrefix: "IMP" });
    mockSidebarPreferencesApi.updateProjectOrder.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) {
      const currentRoot = root;
      await act(async () => {
        currentRoot.unmount();
      });
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function findButton(matches: (text: string) => boolean) {
    return Array.from(container.querySelectorAll("button"))
      .find((button) => matches(button.textContent?.trim() ?? "")) as HTMLButtonElement | undefined;
  }

  async function clickButton(matches: (text: string) => boolean) {
    const button = findButton(matches);
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
  }

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const currentRoot = root;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <CompanyImport />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function enterGithubUrl(url = "https://github.com/acme/starter/tree/main/company") {
    const urlInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="https://github.com/owner/repo/tree/main/company"]',
    );
    expect(urlInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(urlInput!, url);
      urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  async function renderPageAndImport() {
    await renderPage();
    await enterGithubUrl();

    await clickButton((text) => text === "Preview import");

    // Paused-import checkbox is present and checked by default.
    const pauseLabel = Array.from(container.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Start imported agents and routines paused"));
    expect(pauseLabel).toBeTruthy();
    expect(pauseLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);

    await clickButton((text) => text.startsWith("Import 3 file"));
  }

  it("shows the activation panel after import and activates selected agents and routines", async () => {
    await renderPageAndImport();

    expect(mockCompaniesApi.importBundle).toHaveBeenCalledWith(
      expect.objectContaining({ pauseAutomations: true }),
    );
    expect(container.textContent).toContain("Import complete");
    expect(container.textContent).toContain("Activate imported agents and routines");
    expect(container.textContent).toContain("Coder");
    expect(container.textContent).toContain("Weekly Report");

    await clickButton((text) => text.startsWith("Activate selected"));

    expect(mockAgentsApi.resume).toHaveBeenCalledWith("agent-1");
    expect(mockRoutinesApi.update).toHaveBeenCalledWith("routine-1", { status: "active" });
    expect(container.textContent).toContain("activated");
    expect(container.textContent).not.toContain("failed:");
    expect(findButton((text) => text === "Go to dashboard")).toBeTruthy();
  });

  it("keeps activating remaining items and surfaces per-item failures", async () => {
    mockAgentsApi.resume.mockRejectedValue(new Error("resume exploded"));
    await renderPageAndImport();

    await clickButton((text) => text.startsWith("Activate selected"));

    expect(mockAgentsApi.resume).toHaveBeenCalledWith("agent-1");
    expect(mockRoutinesApi.update).toHaveBeenCalledWith("routine-1", { status: "active" });
    expect(container.textContent).toContain("failed: resume exploded");
    expect(container.textContent).toContain("activated");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("blocks oversized local packages until attachments are dropped", async () => {
    // A synthetic parsed package: the base64 blob payload alone exceeds the
    // inline import limit, so no real 60MB zip needs to be built.
    mockReadZipArchive.mockResolvedValue({
      rootPath: "big-package",
      files: {
        "COMPANY.md": "---\nname: Big\n---\n",
        ".paperclip.yaml": 'schema: "paperclip/v1"\n',
        "blobs/4f2d1c9a": {
          encoding: "base64",
          data: "A".repeat(57 * 1024 * 1024),
          contentType: "application/octet-stream",
        },
      },
    });

    await renderPage();

    await clickButton((text) => text.includes("Local zip"));

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    const file = new File(["stub"], "big-package.zip", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(0) });
    Object.defineProperty(fileInput!, "files", { value: [file] });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("CLI folder import");
    expect(container.textContent).toContain("Package too large for browser import");
    expect(findButton((text) => text === "Preview import")?.disabled).toBe(true);

    await clickButton((text) => text === "Continue without attachments");

    expect(container.textContent).not.toContain("CLI folder import");
    expect(container.textContent).not.toContain("Package too large for browser import");
    expect(findButton((text) => text === "Preview import")?.disabled).toBe(false);

    await clickButton((text) => text === "Preview import");
    await clickButton((text) => text.startsWith("Import 3 file"));

    expect(mockCompaniesApi.importBundle).toHaveBeenCalledTimes(1);
    const request = mockCompaniesApi.importBundle.mock.calls[0]![0] as {
      source: { type: string; files: Record<string, unknown> };
    };
    expect(request.source.type).toBe("inline");
    expect(Object.keys(request.source.files).sort()).toEqual([".paperclip.yaml", "COMPANY.md"]);
  });

  it("explains the disabled preview button until a package is chosen", async () => {
    await renderPage();

    expect(findButton((text) => text === "Preview import")?.disabled).toBe(true);
    expect(container.textContent).toContain("Choose a package above to enable the preview.");

    await enterGithubUrl();

    expect(findButton((text) => text === "Preview import")?.disabled).toBe(false);
    expect(container.textContent).not.toContain("Choose a package above to enable the preview.");
  });

  it("shows a progress panel while the preview runs and a durable error panel when it fails", async () => {
    let rejectPreview!: (err: Error) => void;
    mockCompaniesApi.importPreview.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPreview = reject;
        }),
    );
    await renderPage();
    await enterGithubUrl();

    await clickButton((text) => text === "Preview import");

    expect(container.textContent).toContain("Uploading and analyzing your package");
    expect(container.textContent).toContain("Keep this page open.");

    // A mid-flight config edit keeps the progress panel visible (the request
    // really is still running) but supersedes the request, so its failure
    // settles silently instead of describing a package no longer selected.
    await enterGithubUrl("https://github.com/acme/starter-b/tree/main/company");

    expect(container.textContent).toContain("Uploading and analyzing your package");

    await act(async () => {
      rejectPreview(new Error("stream disconnected"));
    });
    await flushReact();

    expect(container.textContent).not.toContain("Uploading and analyzing your package");
    expect(container.textContent).not.toContain("Preview failed:");
    expect(mockPushToast).not.toHaveBeenCalled();

    // A failure of the currently configured request renders a durable panel.
    await clickButton((text) => text === "Preview import");
    await act(async () => {
      rejectPreview(new Error("stream disconnected"));
    });
    await flushReact();

    expect(container.textContent).toContain("Preview failed: stream disconnected");
    expect(container.textContent).toContain("Retry, or use the CLI folder import");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));

    // Changing the package supersedes the failed request: the error panel resets.
    await enterGithubUrl("https://github.com/acme/other-starter/tree/main/company");

    expect(container.textContent).not.toContain("Preview failed:");
  });

  it("shows a progress panel while the import runs and a durable error panel when it fails", async () => {
    let rejectImport!: (err: Error) => void;
    mockCompaniesApi.importBundle.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectImport = reject;
        }),
    );
    await renderPage();
    await enterGithubUrl();
    await clickButton((text) => text === "Preview import");

    await clickButton((text) => text.startsWith("Import 3 file"));

    expect(container.textContent).toContain("Uploading and importing");
    expect(container.textContent).toContain("Keep this page open.");

    // Config edits while the import is in flight must not detach it from
    // the UI: the progress panel keeps reporting it until it settles.
    const midFlightNameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Imported Company"]',
    );
    expect(midFlightNameInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(midFlightNameInput!, "Mid Flight");
      midFlightNameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Uploading and importing");

    await act(async () => {
      rejectImport(new Error("connection reset"));
    });
    await flushReact();

    expect(container.textContent).not.toContain("Uploading and importing");
    expect(container.textContent).toContain("Import failed: connection reset");
    expect(container.textContent).toContain("check the target company before retrying.");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));

    // The new-company name feeds the request payload too: editing it clears
    // the stale error panel without discarding the rendered preview.
    const nameInput = container.querySelector<HTMLInputElement>('input[placeholder="Imported Company"]');
    expect(nameInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameInput!, "Renamed Import");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).not.toContain("Import failed:");
    expect(findButton((text) => text.startsWith("Import 3 file"))).toBeTruthy();

    // Changing the package supersedes the failed import: previewing a fresh
    // package must not resurface the stale import error panel.
    await enterGithubUrl("https://github.com/acme/other-starter/tree/main/company");
    await clickButton((text) => text === "Preview import");

    expect(findButton((text) => text.startsWith("Import 3 file"))).toBeTruthy();
    expect(container.textContent).not.toContain("Import failed:");
  });
});
