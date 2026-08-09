import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

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

export type Phase7iProxyConfig = {
  socketPath: string;
  port: number;
  bindHost: string;
  publicOrigin: URL;
};

export function resolvePhase7iProxyConfig(env: NodeJS.ProcessEnv): Phase7iProxyConfig {
  const socketPath = env.PHASE7I_SOCKET_PATH?.trim() ?? "";
  const port = Number(env.PHASE7I_PROXY_PORT);
  const bindHost = env.PHASE7I_PROXY_HOST?.trim() || "127.0.0.1";
  const allowInsecureHttp = env.PHASE7I_ALLOW_INSECURE_HTTP === "1";
  const publicOrigin = new URL(env.PHASE7I_PUBLIC_ORIGIN ?? "");
  const directTailnetHttp = publicOrigin.protocol === "http:" && allowInsecureHttp;
  const loopbackBind = bindHost === "127.0.0.1" || bindHost === "::1";
  if (
    !socketPath
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || isIP(bindHost) === 0
    || (publicOrigin.protocol !== "https:" && !directTailnetHttp)
    || (!loopbackBind && !directTailnetHttp)
  ) {
    throw new Error(
      "PHASE7I_SOCKET_PATH, an allowed PHASE7I_PUBLIC_ORIGIN/bind mode, and a valid PHASE7I_PROXY_PORT are required",
    );
  }
  return { socketPath, port, bindHost, publicOrigin };
}

export function selectedPhase7iProxyHeaders(
  headers: IncomingHttpHeaders,
  publicOrigin: URL,
  remoteAddress: string | undefined,
): Record<string, string | string[]> {
  const selected: Record<string, string | string[]> = {};
  const directTailnetHttp = publicOrigin.protocol === "http:";
  for (const [name, value] of Object.entries(headers)) {
    if (!FORWARDED_HEADERS.has(name) || value === undefined) continue;
    if (
      directTailnetHttp
      && (name === "tailscale-user-login" || name === "tailscale-user-name" || name === "x-forwarded-for")
    ) {
      continue;
    }
    selected[name] = value;
  }
  selected.host = publicOrigin.host;
  selected["x-forwarded-proto"] = publicOrigin.protocol.slice(0, -1);
  selected["x-forwarded-host"] = publicOrigin.host;
  if (directTailnetHttp) selected["x-forwarded-for"] = remoteAddress ?? "tailnet-peer";
  selected["x-phase7i-proxy"] = "v1";
  return selected;
}
