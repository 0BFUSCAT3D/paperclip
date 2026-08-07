import { randomUUID } from "node:crypto";

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function writeRecord(response, value) {
  response.write(`${JSON.stringify(value)}\n`);
}

export function phase2BrowserServerPlugin() {
  const runs = new Map();

  async function middleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://phase2.local");
    if (!url.pathname.startsWith("/api/phase2/")) {
      next();
      return;
    }

    const runnerModuleUrl = new URL(
      "../dist/mock-core/phase2-local-runner.js",
      import.meta.url,
    ).href;
    const runner = await import(runnerModuleUrl);
    if (request.method === "POST" && url.pathname === "/api/phase2/runs") {
      try {
        const body = await readJson(request);
        const id = randomUUID();
        const history = [];
        const clients = new Set();
        const publish = (record) => {
          history.push(record);
          for (const client of clients) {
            writeRecord(client, record);
          }
        };
        const handle = await runner.startPhase2Scenario({
          scenario: body.scenario,
          delayMs: 30,
          onEvent(event) {
            publish({ kind: "event", event });
          },
          onDiagnostic(message) {
            publish({ kind: "diagnostic", message });
          },
        });
        const entry = { id, handle, history, clients, finished: false, trace: null };
        runs.set(id, entry);
        handle.completion.then(
          (trace) => {
            entry.trace = trace;
            entry.finished = true;
            publish({ kind: "trace", trace });
            for (const client of clients) {
              client.end();
            }
            clients.clear();
          },
          (error) => {
            entry.finished = true;
            publish({ kind: "error", message: String(error) });
            for (const client of clients) {
              client.end();
            }
            clients.clear();
          },
        );
        json(response, 201, { id, metadata: handle.metadata });
      } catch (error) {
        json(response, 400, { error: String(error) });
      }
      return;
    }

    const match = url.pathname.match(/^\/api\/phase2\/runs\/([^/]+)(?:\/(events|interrupt|resolve))?$/);
    if (match === null) {
      json(response, 404, { error: "Phase 2 route not found" });
      return;
    }
    const entry = runs.get(match[1]);
    if (entry === undefined) {
      json(response, 404, { error: "Phase 2 run not found" });
      return;
    }
    const action = match[2];
    if (request.method === "GET" && action === "events") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      for (const record of entry.history) {
        writeRecord(response, record);
      }
      if (entry.finished) {
        response.end();
      } else {
        entry.clients.add(response);
        request.on("close", () => entry.clients.delete(response));
      }
      return;
    }
    if (request.method === "POST" && action === "interrupt") {
      try {
        const receipt = await entry.handle.interrupt("browser_operator");
        json(response, 200, receipt);
      } catch (error) {
        json(response, 409, { error: String(error) });
      }
      return;
    }
    if (request.method === "POST" && action === "resolve") {
      try {
        const body = await readJson(request);
        const receipt = await entry.handle.resolveRequest(body.requestId, body.response ?? {});
        json(response, 200, receipt);
      } catch (error) {
        json(response, 409, { error: String(error) });
      }
      return;
    }
    json(response, 405, { error: "Method not allowed" });
  }

  return {
    name: "paperclip-runner-phase2-live-server",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
