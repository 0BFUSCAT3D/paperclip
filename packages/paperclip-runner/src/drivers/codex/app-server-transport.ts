import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexRpcServerRequest extends CodexRpcNotification {
  id: string | number;
}

export type CodexServerRequestHandler = (
  request: CodexRpcServerRequest,
) => Promise<Record<string, unknown>>;

export interface CodexAppServerTransport {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  notifications(): AsyncIterable<CodexRpcNotification>;
  setServerRequestHandler(handler: CodexServerRequestHandler): void;
  close(): Promise<void>;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

const SAFE_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "CODEX_HOME",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
] as const;

export function createSanitizedCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (key.includes("PROXY") && proxyContainsCredentials(value)) continue;
    environment[key] = value;
  }
  return environment;
}

export function sanitizedEnvironmentKeys(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(createSanitizedCodexEnvironment(source)).sort();
}

export function redactCodexDiagnostic(message: string): string {
  return message
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(["'](?:api[_-]?key|token|secret|password|authorization)["']\s*:\s*["'])[^"']+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(PAPERCLIP_API_KEY|OPENAI_API_KEY)=[^\s]+/g, "$1=[REDACTED]");
}

function proxyContainsCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return true;
  }
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export interface ProcessCodexTransportOptions {
  command?: string;
  args?: string[];
  environment?: NodeJS.ProcessEnv;
  onDiagnostic?: (message: string) => void;
}

/** Local stdio JSON-RPC transport. App-server never becomes a WAN endpoint. */
export class ProcessCodexAppServerTransport implements CodexAppServerTransport {
  #process: ChildProcessWithoutNullStreams;
  #notifications = new AsyncQueue<CodexRpcNotification>();
  #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #serverRequestHandler: CodexServerRequestHandler = async () => ({
    success: false,
    contentItems: [{ type: "input_text", text: "Unsupported client request." }],
  });
  #closed = false;
  #onDiagnostic?: (message: string) => void;

  constructor(options: ProcessCodexTransportOptions = {}) {
    this.#onDiagnostic = options.onDiagnostic;
    this.#process = spawn(options.command ?? "codex", options.args ?? ["app-server"], {
      env: options.environment ?? createSanitizedCodexEnvironment(),
      stdio: "pipe",
    });
    createInterface({ input: this.#process.stdout }).on("line", (line) => this.#onLine(line));
    createInterface({ input: this.#process.stderr }).on("line", (line) => {
      this.#onDiagnostic?.(redactCodexDiagnostic(line));
    });
    this.#process.on("error", (error) => this.#failAll(error));
    this.#process.on("exit", (code, signal) => {
      if (!this.#closed) {
        this.#failAll(new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "none"})`));
      }
      this.#notifications.close();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.#notifications;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#process.kill("SIGTERM");
    this.#notifications.close();
    this.#failAll(new Error("codex app-server transport closed"));
  }

  #write(message: unknown): void {
    if (this.#closed) throw new Error("codex app-server transport is closed");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#onDiagnostic?.("codex app-server emitted malformed JSON");
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const message = value as Record<string, unknown>;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(redactCodexDiagnostic(JSON.stringify(message.error))));
      } else {
        pending.resolve(asRecord(message.result));
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const params = asRecord(message.params);
    if ((typeof message.id === "string" || typeof message.id === "number") && "id" in message) {
      const request: CodexRpcServerRequest = { id: message.id, method: message.method, params };
      void this.#serverRequestHandler(request).then(
        (result) => this.#write({ id: request.id, result }),
        (error: unknown) =>
          this.#write({
            id: request.id,
            error: { code: -32_000, message: redactCodexDiagnostic(String(error)) },
          }),
      );
      return;
    }
    this.#notifications.push({ method: message.method, params });
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
