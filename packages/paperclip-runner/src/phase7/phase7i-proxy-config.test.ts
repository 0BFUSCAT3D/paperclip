import { describe, expect, it } from "vitest";

import {
  resolvePhase7iProxyConfig,
  selectedPhase7iProxyHeaders,
} from "./phase7i-proxy-config.js";

const baseEnv = {
  PHASE7I_SOCKET_PATH: "/tmp/phase7i.sock",
  PHASE7I_PROXY_PORT: "4197",
};

describe("Phase 7I proxy configuration", () => {
  it("keeps HTTPS loopback-only by default", () => {
    expect(resolvePhase7iProxyConfig({
      ...baseEnv,
      PHASE7I_PUBLIC_ORIGIN: "https://phase7i.example.ts.net",
    })).toMatchObject({
      bindHost: "127.0.0.1",
      port: 4197,
      socketPath: "/tmp/phase7i.sock",
    });
    expect(() => resolvePhase7iProxyConfig({
      ...baseEnv,
      PHASE7I_PUBLIC_ORIGIN: "https://phase7i.example.ts.net",
      PHASE7I_PROXY_HOST: "0.0.0.0",
    })).toThrow(/allowed .*bind mode/);
  });

  it("requires explicit tailnet HTTP opt-in before binding beyond loopback", () => {
    expect(() => resolvePhase7iProxyConfig({
      ...baseEnv,
      PHASE7I_PUBLIC_ORIGIN: "http://phase7i.example.ts.net:4197",
      PHASE7I_PROXY_HOST: "0.0.0.0",
    })).toThrow(/allowed .*bind mode/);
    expect(resolvePhase7iProxyConfig({
      ...baseEnv,
      PHASE7I_PUBLIC_ORIGIN: "http://phase7i.example.ts.net:4197",
      PHASE7I_PROXY_HOST: "0.0.0.0",
      PHASE7I_ALLOW_INSECURE_HTTP: "1",
    })).toMatchObject({
      bindHost: "0.0.0.0",
      port: 4197,
    });
  });

  it("derives direct-tailnet identity from the socket instead of spoofable headers", () => {
    const headers = selectedPhase7iProxyHeaders({
      cookie: "paperclip_phase7i=capability",
      "tailscale-user-login": "spoof@example.com",
      "tailscale-user-name": "Spoofed User",
      "x-forwarded-for": "203.0.113.10",
    }, new URL("http://phase7i.example.ts.net:4197"), "100.64.0.2");
    expect(headers).toMatchObject({
      host: "phase7i.example.ts.net:4197",
      cookie: "paperclip_phase7i=capability",
      "x-forwarded-for": "100.64.0.2",
      "x-forwarded-host": "phase7i.example.ts.net:4197",
      "x-forwarded-proto": "http",
      "x-phase7i-proxy": "v1",
    });
    expect(headers).not.toHaveProperty("tailscale-user-login");
    expect(headers).not.toHaveProperty("tailscale-user-name");
  });
});
