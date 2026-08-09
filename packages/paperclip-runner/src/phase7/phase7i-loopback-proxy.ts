import { request as proxyRequest, createServer, type IncomingHttpHeaders } from "node:http";

const MAX_BODY_BYTES = 64 * 1024;
const FORWARDED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "origin",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "tailscale-user-login",
  "tailscale-user-name",
  "user-agent",
  "x-forwarded-for",
]);

function selectedHeaders(
  headers: IncomingHttpHeaders,
  publicHost: string,
): Record<string, string | string[]> {
  const selected: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!FORWARDED_HEADERS.has(name) || value === undefined) continue;
    selected[name] = value;
  }
  selected.host = publicHost;
  selected["x-forwarded-proto"] = "https";
  selected["x-forwarded-host"] = publicHost;
  selected["x-phase7i-proxy"] = "v1";
  return selected;
}

function main(): void {
  const socketPath = process.env.PHASE7I_SOCKET_PATH?.trim();
  const port = Number(process.env.PHASE7I_PROXY_PORT);
  const publicOrigin = new URL(process.env.PHASE7I_PUBLIC_ORIGIN ?? "");
  if (
    !socketPath
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || publicOrigin.protocol !== "https:"
  ) {
    throw new Error("PHASE7I_SOCKET_PATH, PHASE7I_PUBLIC_ORIGIN, and a valid PHASE7I_PROXY_PORT are required");
  }

  const server = createServer((req, res) => {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      res.writeHead(413, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      res.end('{"error":{"code":"request_too_large","message":"Request body exceeds the 64 KiB limit."}}');
      return;
    }

    const upstream = proxyRequest({
      socketPath,
      method: req.method,
      path: req.url,
      headers: selectedHeaders(req.headers, publicOrigin.host),
      timeout: 35_000,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.once("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.once("error", () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      res.end('{"error":{"code":"upstream_unavailable","message":"Demo service is unavailable."}}');
    });
    req.pipe(upstream);
  });
  server.maxConnections = 32;
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, "127.0.0.1");

  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "proxy_startup_failed",
    code: error instanceof Error ? error.name : "Error",
  })}\n`);
  process.exitCode = 1;
}
