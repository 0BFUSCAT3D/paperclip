import { describe, expect, it } from "vitest";
import { classifySubscriptionOnlyProviderPolicy } from "./subscription-billing-policy.js";

function classify(adapterType: "claude_local" | "codex_local", env: Record<string, string>) {
  return classifySubscriptionOnlyProviderPolicy({
    adapterType,
    config: { billingPolicy: "subscription_only" },
    env,
  });
}

describe("subscription-only provider environment classification", () => {
  it.each([
    "HTTP_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "node_tls_reject_unauthorized",
    "SSL_CERT_FILE",
    "ssl_cert_dir",
  ])("rejects transport interception for both adapters, case-insensitively: %s", (key) => {
    expect(classify("claude_local", { [key]: "configured" })).toBe("metered_provider_selected");
    expect(classify("codex_local", { [key]: "configured" })).toBe("metered_provider_selected");
  });

  it.each([
    "CLAUDE_CODE_HTTP_PROXY",
    "claude_code_proxy_url",
    "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
    "GLOBAL_AGENT_HTTP_PROXY",
    "MCP_PROXY_URL",
  ])("rejects Claude executable-chain transport controls: %s", (key) => {
    expect(classify("claude_local", { [key]: "configured" })).toBe("metered_provider_selected");
  });

  it.each([
    "CODEX_CA_CERTIFICATE",
    "codex_network_proxy_active",
    "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "GIT_SSL_NO_VERIFY",
  ])("rejects Codex executable-chain transport controls: %s", (key) => {
    expect(classify("codex_local", { [key]: "configured" })).toBe("metered_provider_selected");
  });

  it.each([
    ["Foundry selector", "CLAUDE_CODE_USE_FOUNDRY", "1", "metered_provider_selected"],
    ["Foundry API key", "ANTHROPIC_FOUNDRY_API_KEY", "secret", "metered_credential_present"],
    ["Foundry auth token", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "secret", "metered_credential_present"],
    ["Foundry base URL", "ANTHROPIC_FOUNDRY_BASE_URL", "https://foundry.test", "metered_provider_selected"],
    ["Foundry resource", "ANTHROPIC_FOUNDRY_RESOURCE", "resource", "metered_provider_selected"],
    ["Mantle selector", "CLAUDE_CODE_USE_MANTLE", "1", "metered_provider_selected"],
    ["Mantle key", "MANTLE_OPUS_KEY", "secret", "metered_credential_present"],
    ["Mantle base URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "https://mantle.test", "metered_provider_selected"],
    ["Gateway selector", "CLAUDE_CODE_USE_GATEWAY", "1", "metered_provider_selected"],
    ["managed settings", "CLAUDE_CODE_MANAGED_SETTINGS_PATH", "/tmp/managed.json", "metered_provider_selected"],
    ["remote settings", "CLAUDE_CODE_REMOTE_SETTINGS_PATH", "https://settings.test", "metered_provider_selected"],
    ["host provider", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1", "metered_provider_selected"],
    ["process wrapper", "CLAUDE_CODE_PROCESS_WRAPPER", "/tmp/wrapper", "metered_provider_selected"],
    ["Anthropic AWS selector", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "1", "metered_provider_selected"],
    ["Anthropic AWS key", "ANTHROPIC_AWS_API_KEY", "secret", "metered_credential_present"],
    ["Anthropic Google selector", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "1", "metered_provider_selected"],
    ["Anthropic Google base URL", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL", "https://google.test", "metered_provider_selected"],
    ["Azure client secret", "AZURE_CLIENT_SECRET", "secret", "metered_credential_present"],
  ])("rejects installed Claude provider env: %s", (_label, key, value, expected) => {
    expect(classify("claude_local", { [key]: value })).toBe(expected);
  });

  it.each([
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
  ])("allows the first-party model-only key %s", (key) => {
    expect(classify("claude_local", { [key]: "claude-model" })).toBeNull();
  });

  it("allows the exact first-party Claude OAuth token route", () => {
    expect(classify("claude_local", { CLAUDE_CODE_OAUTH_TOKEN: "secret" })).toBeNull();
  });

  it.each(["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV"])(
    "rejects loader or shell injection from the final merged env: %s",
    (key) => {
      expect(classify("claude_local", { [key]: "configured" })).toBe("metered_provider_selected");
    },
  );

  it.each([
    ["OPENAI_API_KEY", "metered_credential_present"],
    ["OPENAI_BASE_URL", "metered_provider_selected"],
    ["OPENAI_ORGANIZATION", "metered_provider_selected"],
    ["OPENAI_PROJECT", "metered_provider_selected"],
    ["OPENAI_ACCESS_TOKEN", "metered_credential_present"],
    ["CODEX_API_KEY", "metered_credential_present"],
    ["CODEX_ACCESS_TOKEN", "metered_credential_present"],
    ["CODEX_PROVIDER", "metered_provider_selected"],
  ])("rejects nonempty Codex provider env %s", (key, expected) => {
    expect(classify("codex_local", { [key]: "configured" })).toBe(expected);
  });

  it.each(["CODEX_HOME", "CODEX_CI", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_SHELL", "CODEX_THREAD_ID"])(
    "allows the non-provider Codex runtime key %s",
    (key) => {
      expect(classify("codex_local", { [key]: "configured" })).toBeNull();
    },
  );

  it("leaves CODEX_HOME specifically to the adapter's managed-home containment proof", () => {
    expect(classify("codex_local", { CODEX_HOME: "/managed/home" })).toBeNull();
  });
});
