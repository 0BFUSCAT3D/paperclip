import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Mounts the Phase 4b demo-server routes inside the standalone Vite devtool.
 *
 * The browser never talks to a provider. Only this Node process starts a
 * driver, owns the working directory, and reads any provider login. The
 * default driver replays deterministic demo manifests; setting
 * `PAPERCLIP_PHASE4B_DRIVER=codex` swaps in the real Codex app-server driver
 * behind exactly the same routes.
 */
const LOOPBACK_ONLY = "Phase 4b is available only over loopback";

function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "[::1]" || normalized === "localhost") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function rejectUntrusted(request, response) {
  if (
    !isLoopbackAddress(request.socket.localAddress) ||
    !isLoopbackAddress(request.socket.remoteAddress)
  ) {
    response.statusCode = 403;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "forbidden", message: LOOPBACK_ONLY }));
    return true;
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    Array.isArray(fetchSite) ||
    (typeof fetchSite === "string" && !["same-origin", "none"].includes(fetchSite))
  ) {
    response.statusCode = 403;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: "forbidden",
      message: "Phase 4b cross-site requests are forbidden",
    }));
    return true;
  }
  return false;
}

async function loadRunner() {
  return import(new URL("../dist/index.js", import.meta.url).href);
}

async function createWorkingDirectory() {
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  return mkdtemp(resolve(scratchRoot, "phase4b-browser-"));
}

export function createPhase4bBrowserMiddleware(options = {}) {
  const load = options.loadRunner ?? loadRunner;
  const driverMode = options.driverMode ?? process.env.PAPERCLIP_PHASE4B_DRIVER ?? "demo";
  const chunkDelayMs = Number.parseInt(
    options.chunkDelayMs ?? process.env.PAPERCLIP_PHASE4B_CHUNK_DELAY_MS ?? "45",
    10,
  );
  let bootstrap = null;

  async function ready() {
    if (bootstrap !== null) return bootstrap;
    bootstrap = (async () => {
      const runner = await load();
      const workingDirectory =
        options.workingDirectory ?? (await createWorkingDirectory());
      const server = new runner.Phase4bDemoServer({
        workingDirectory,
        manifests: runner.phase4bDemoManifestCatalogue(),
        driverFactory: (taskEnvelope, manifestId) =>
          driverMode === "codex"
            ? new runner.CodexAppServerDriver({
                taskEnvelope,
                onDiagnostic: (message) => process.stderr.write(`[phase4b] ${message}\n`),
              })
            : new runner.Phase4bScriptedDriver({
                manifestId: manifestId ?? "completion",
                chunkDelayMs: Number.isInteger(chunkDelayMs) ? chunkDelayMs : 45,
              }),
      });
      return { handle: server.middleware(), server, workingDirectory };
    })();
    return bootstrap;
  }

  const middleware = async function phase4bMiddleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://phase4b.local");
    if (!url.pathname.startsWith("/api/phase4b/")) {
      next();
      return;
    }
    if (rejectUntrusted(request, response)) return;
    try {
      const { handle } = await ready();
      handle(request, response);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        error: "phase4b_unavailable",
        message: String(error instanceof Error ? error.message : error),
      }));
    }
  };
  middleware.close = async () => {
    if (bootstrap === null) return;
    const { server } = await bootstrap;
    await server.close();
  };
  return middleware;
}

export function phase4bBrowserServerPlugin(options = {}) {
  const middleware = createPhase4bBrowserMiddleware(options);
  return {
    name: "paperclip-runner-phase4b-live-console-server",
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", () => void middleware.close());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", () => void middleware.close());
    },
  };
}

export const phase4bBrowserServerInternals = { isLoopbackAddress };
