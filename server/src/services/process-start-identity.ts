import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveLinuxProcessStartTokenFromProof(input: {
  bootId: string;
  stat: string;
}): string {
  const close = input.stat.lastIndexOf(")");
  if (close < 0) throw new Error("Executor process stat is invalid");
  const fieldsAfterName = input.stat.slice(close + 2).trim().split(/\s+/);
  const startTicks = fieldsAfterName[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error("Executor process start identity is unavailable");
  }
  return sha256(`${input.bootId.trim()}\0${startTicks}`);
}

export type DarwinProcessStartProof = {
  pid: number;
  startSeconds: string;
  startMicroseconds: string;
};

export type CapturedLocalProcessStartIdentity = {
  pid: number;
  startToken: string;
};

interface DarwinProcessStartBinding {
  getProcessStartIdentity(pid: number): DarwinProcessStartProof;
}

let darwinBinding: DarwinProcessStartBinding | null | undefined;

function loadDarwinProcessStartBinding(): DarwinProcessStartBinding {
  if (darwinBinding) return darwinBinding;
  if (darwinBinding === null) throw new Error("Exact Darwin process-start native binding is unavailable");
  try {
    const require = createRequire(import.meta.url);
    const bindingPath = fileURLToPath(new URL("../../dist/process-start-native.node", import.meta.url));
    darwinBinding = require(bindingPath) as DarwinProcessStartBinding;
    return darwinBinding;
  } catch (error) {
    darwinBinding = null;
    throw new Error(
      `Exact Darwin process-start native binding is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function deriveDarwinProcessStartTokenFromProof(input: DarwinProcessStartProof): string {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) throw new Error("Executor pid is invalid");
  if (!/^\d+$/.test(input.startSeconds) || input.startSeconds === "0") {
    throw new Error("Executor process start seconds are invalid");
  }
  if (!/^\d+$/.test(input.startMicroseconds)) {
    throw new Error("Executor process start microseconds are invalid");
  }
  const microseconds = Number(input.startMicroseconds);
  if (!Number.isSafeInteger(microseconds) || microseconds < 0 || microseconds >= 1_000_000) {
    throw new Error("Executor process start microseconds are invalid");
  }
  const startSeconds = BigInt(input.startSeconds).toString(10);
  return sha256(
    `paperclip-darwin-proc-pidbsdinfo-v1\0${input.pid}\0${startSeconds}\0${microseconds}`,
  );
}

export function captureLocalProcessStartIdentity(pid: number): CapturedLocalProcessStartIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Executor pid is invalid");
  if (process.platform === "linux") {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return { pid, startToken: deriveLinuxProcessStartTokenFromProof({ bootId, stat }) };
  }
  if (process.platform === "darwin") {
    return {
      pid,
      startToken: deriveDarwinProcessStartTokenFromProof(
        loadDarwinProcessStartBinding().getProcessStartIdentity(pid),
      ),
    };
  }
  throw new Error(`Executor process start identity is unsupported on ${process.platform}`);
}

export function assertCapturedLocalProcessIdentityCurrent(
  captured: CapturedLocalProcessStartIdentity,
  observe: (pid: number) => CapturedLocalProcessStartIdentity = captureLocalProcessStartIdentity,
): void {
  const current = observe(captured.pid);
  if (current.pid !== captured.pid || current.startToken !== captured.startToken) {
    throw new Error("Executor process instance changed before launch receipt persistence");
  }
}

export function supportsExactLocalProcessStartIdentity(
  observe: (pid: number) => CapturedLocalProcessStartIdentity = captureLocalProcessStartIdentity,
): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin") return false;
  try {
    const captured = observe(process.pid);
    assertCapturedLocalProcessIdentityCurrent(captured, observe);
    return true;
  } catch {
    return false;
  }
}

export async function deriveLocalProcessStartToken(pid: number): Promise<string> {
  return captureLocalProcessStartIdentity(pid).startToken;
}
