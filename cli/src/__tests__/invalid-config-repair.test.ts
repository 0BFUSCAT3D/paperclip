import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import { configure } from "../commands/configure.js";
import { onboard } from "../commands/onboard.js";
import { paperclipConfigSchema } from "../config/schema.js";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock("../prompts/logging.js", () => ({
  promptLogging: vi.fn(async () => ({ mode: "file", logDir: "/tmp/repaired-logs" })),
}));

vi.mock("../onboard-service.js", () => ({
  handleOnboardService: vi.fn(async () => false),
}));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
const roots: string[] = [];

function invalidConfigFixture(): { root: string; configPath: string; contents: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-invalid-config-repair-"));
  roots.push(root);
  const configPath = path.join(root, "config.json");
  const contents = "{\n  invalid: true\n}\n";
  fs.writeFileSync(configPath, contents);
  return { root, configPath, contents };
}

describe("invalid config repair", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.exitCode = undefined;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.exitCode = ORIGINAL_EXIT_CODE;
    Object.defineProperty(process.stdin, "isTTY", { value: ORIGINAL_STDIN_IS_TTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: ORIGINAL_STDOUT_IS_TTY, configurable: true });
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the original and backup when interactive configure repair is declined", async () => {
    const fixture = invalidConfigFixture();
    vi.mocked(prompts.confirm).mockResolvedValue(false);

    await configure({ config: fixture.configPath, section: "logging" });

    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.contents);
    expect(fs.readFileSync(`${fixture.configPath}.invalid-1`, "utf8")).toBe(fixture.contents);
    expect(prompts.cancel).toHaveBeenCalledWith(expect.stringContaining(`${fixture.configPath}.invalid-1`));
  });

  it("atomically repairs configure from defaults after explicit confirmation", async () => {
    const fixture = invalidConfigFixture();
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    const renameSpy = vi.spyOn(fs, "renameSync");

    await configure({ config: fixture.configPath, section: "logging" });

    const repaired = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
    expect(repaired.logging).toEqual({ mode: "file", logDir: "/tmp/repaired-logs" });
    expect(fs.readFileSync(`${fixture.configPath}.invalid-1`, "utf8")).toBe(fixture.contents);
    expect(renameSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\.config\.json\.tmp-/),
      fixture.configPath,
    );
  });

  it("prompts and atomically repairs invalid config during interactive onboarding", async () => {
    const fixture = invalidConfigFixture();
    process.env.PAPERCLIP_HOME = fixture.root;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.mocked(prompts.select).mockResolvedValue("quickstart");
    const renameSpy = vi.spyOn(fs, "renameSync");

    await onboard({ config: fixture.configPath });

    const repaired = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
    expect(repaired.$meta.source).toBe("onboard");
    expect(() => paperclipConfigSchema.parse(repaired)).not.toThrow();
    expect(fs.readFileSync(`${fixture.configPath}.invalid-1`, "utf8")).toBe(fixture.contents);
    expect(renameSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\.config\.json\.tmp-/),
      fixture.configPath,
    );
  });
});
