import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertCapturedLocalProcessIdentityCurrent,
  captureLocalProcessStartIdentity,
  deriveDarwinProcessStartTokenFromProof,
  deriveLinuxProcessStartTokenFromProof,
  deriveLocalProcessStartToken,
  supportsExactLocalProcessStartIdentity,
} from "./process-start-identity.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../..", import.meta.url);

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  await execFileAsync(process.execPath, ["server/scripts/build-process-start-native.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, PAPERCLIP_NATIVE_BUILD_REQUIRED: "1" },
  });
});

function linuxStat(startTicks: string): string {
  const afterName = [
    "S", "1", "1", "1", "0", "0", "0", "0", "0", "0",
    "0", "0", "0", "0", "0", "0", "0", "0", "0", startTicks,
  ];
  return `42 (executor with ) name) ${afterName.join(" ")}`;
}

describe("local process start identity", () => {
  it("derives a stable sha256 identity for the exact live process instance", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const first = await deriveLocalProcessStartToken(process.pid);
    const second = await deriveLocalProcessStartToken(process.pid);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    const captured = captureLocalProcessStartIdentity(process.pid);
    expect(() => assertCapturedLocalProcessIdentityCurrent(captured)).not.toThrow();
  });

  it("fails the capability probe when the live OS identity source is masked", () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    expect(supportsExactLocalProcessStartIdentity(() => {
      throw new Error("identity source masked");
    })).toBe(false);
  });

  it("rejects a reused pid whose current birth token differs from the captured spawn proof", () => {
    const captured = { pid: 42, startToken: "a".repeat(64) };
    expect(() => assertCapturedLocalProcessIdentityCurrent(captured, (pid) => ({
      pid,
      startToken: "b".repeat(64),
    }))).toThrow("process instance changed");
  });

  it("loads and probes exact native process identity on Darwin", async () => {
    if (process.platform !== "darwin") return;
    expect(supportsExactLocalProcessStartIdentity()).toBe(true);
    await expect(deriveLocalProcessStartToken(2_147_483_647)).rejects.toThrow(
      "proc_pidinfo(PROC_PIDTBSDINFO) failed",
    );
  });

  it("distinguishes PID reuse across exact Linux kernel start ticks", () => {
    const first = deriveLinuxProcessStartTokenFromProof({
      bootId: "boot-a",
      stat: linuxStat("100"),
    });
    const reusedPid = deriveLinuxProcessStartTokenFromProof({
      bootId: "boot-a",
      stat: linuxStat("101"),
    });
    expect(reusedPid).not.toBe(first);
  });

  it("binds Darwin identity to PID and microsecond process birth time", () => {
    const first = deriveDarwinProcessStartTokenFromProof({
      pid: 42,
      startSeconds: "1787650000",
      startMicroseconds: "123456",
    });
    const samePidReused = deriveDarwinProcessStartTokenFromProof({
      pid: 42,
      startSeconds: "1787650000",
      startMicroseconds: "123457",
    });
    const differentPid = deriveDarwinProcessStartTokenFromProof({
      pid: 43,
      startSeconds: "1787650000",
      startMicroseconds: "123456",
    });
    expect(samePidReused).not.toBe(first);
    expect(differentPid).not.toBe(first);
  });

  it("builds and packages one deterministic universal Darwin binding", async () => {
    if (process.platform !== "darwin") return;
    const addon = new URL("../../../server/dist/process-start-native.node", import.meta.url);
    const first = createHash("sha256").update(await fs.readFile(addon)).digest("hex");
    await execFileAsync(process.execPath, ["server/scripts/build-process-start-native.mjs"], {
      cwd: repositoryRoot,
      env: { ...process.env, PAPERCLIP_NATIVE_BUILD_REQUIRED: "1" },
    });
    const second = createHash("sha256").update(await fs.readFile(addon)).digest("hex");
    expect(second).toBe(first);
    const architectures = await execFileAsync("/usr/bin/lipo", [
      new URL("../../../server/dist/process-start-native.node", import.meta.url).pathname,
      "-archs",
    ]);
    expect(architectures.stdout.trim().split(/\s+/).sort()).toEqual(["arm64", "x86_64"]);
    const manifest = JSON.parse(await fs.readFile(
      new URL("../../../server/package.json", import.meta.url),
      "utf8",
    )) as { files?: string[]; scripts?: Record<string, string> };
    expect(manifest.files).toEqual(expect.arrayContaining([
      "dist",
      "native",
      "scripts/build-process-start-native.mjs",
    ]));
    expect(manifest.scripts?.build).toContain("PAPERCLIP_NATIVE_BUILD_REQUIRED=1");
    expect(manifest.scripts?.install).toBe("node scripts/build-process-start-native.mjs");
  });
});
