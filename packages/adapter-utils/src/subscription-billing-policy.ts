/**
 * Stable, non-secret failure codes for the opt-in native subscription-only
 * execution policy. Adapters must fail before creating a provider process when
 * this policy cannot prove native subscription authentication.
 */
export const SUBSCRIPTION_BILLING_POLICY_FAILURE_CODES = [
  "subscription_auth_missing",
  "metered_credential_present",
  "metered_provider_selected",
  "subscription_auth_unverifiable",
  "subscription_environment_unsupported",
] as const;

export type SubscriptionBillingPolicyFailureCode =
  (typeof SUBSCRIPTION_BILLING_POLICY_FAILURE_CODES)[number];

export const SUBSCRIPTION_ONLY_BILLING_POLICY = "subscription_only" as const;

export const SUBSCRIPTION_ONLY_BILLING_CAPABILITY = {
  supported: true,
  version: 1,
  policy: SUBSCRIPTION_ONLY_BILLING_POLICY,
  localExecutionOnly: true,
  supportedEngines: ["cli"],
  acpSupported: false,
  enforcesEnvironmentTest: true,
  billingEvidence: "local_preflight_classification",
  exactBillingReceiptRequired: false,
  trustedHostExecutablePrerequisite: true,
} as const;

export type SubscriptionOnlyBillingCapability = typeof SUBSCRIPTION_ONLY_BILLING_CAPABILITY;

export const SUBSCRIPTION_POLICY_ENV_KEYS = {
  claude_local: {
    credentials: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_OAUTH_ACCESS_TOKEN",
    ],
    providers: [
      "CLAUDE_CODE_USE_BEDROCK",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "CLAUDE_CODE_USE_VERTEX",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_URL",
    ],
  },
  codex_local: {
    credentials: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
    providers: ["OPENAI_BASE_URL", "OPENAI_API_BASE", "PAPERCLIP_CODEX_PROVIDERS"],
  },
} as const;

export const SUBSCRIPTION_POLICY_INJECTION_ENV_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;

export const SUBSCRIPTION_POLICY_FINAL_ENV_INJECTION_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
] as const;

/**
 * Transport interception variables recognized by the supported Claude/Codex
 * executable chains. These are matched case-insensitively because common HTTP
 * clients honor both upper- and lower-case proxy spellings.
 */
export const SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
  "WS_PROXY",
  "WSS_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_NO_VERIFY",
  "CARGO_HTTP_CAINFO",
  "PIP_CERT",
  "PIP_PROXY",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_HTTP_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_PROXY",
  "BUNDLE_SSL_CA_CERT",
  "BUNDLE_HTTP_PROXY",
  "BUNDLE_HTTPS_PROXY",
  "NIX_SSL_CERT_FILE",
  "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
  "YARN_HTTP_PROXY",
  "YARN_HTTPS_PROXY",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  "GLOBAL_AGENT_HTTP_PROXY",
  "GLOBAL_AGENT_HTTPS_PROXY",
  "GLOBAL_AGENT_NO_PROXY",
  "AGENT_PROXY_URL",
  "MCP_PROXY_URL",
  "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE",
  "CLAUDE_CODE_HTTP_PROXY",
  "CLAUDE_CODE_HTTPS_PROXY",
  "CLAUDE_CODE_PROXY_URL",
  "CLAUDE_CODE_PROXY_HOST",
  "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
  "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
  "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
  "CODEX_CA_CERTIFICATE",
  "CODEX_NETWORK_PROXY_ACTIVE",
  "CODEX_NETWORK_PROXY_ATTRIBUTION",
  "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE",
  "CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS",
  "CODEX_PROXY_GIT_SSH_COMMAND",
] as const;

const SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEY_SET = new Set<string>(
  SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS,
);

const CLAUDE_SUBSCRIPTION_ALLOWED_ANTHROPIC_ENV_KEYS = new Set([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
]);

const CLAUDE_PROVIDER_ENV_PREFIXES = [
  "AWS_",
  "GOOGLE_",
  "GCLOUD_",
  "CLOUD_ML_",
  "AZURE_",
  "MANTLE_",
] as const;

const CODEX_SUBSCRIPTION_ALLOWED_ENV_KEYS = new Set([
  "CODEX_HOME",
  "CODEX_CI",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_SHELL",
  "CODEX_THREAD_ID",
]);

const CREDENTIAL_ENV_NAME_FRAGMENT =
  /(?:API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|ACCESS_?KEY|CREDENTIAL|IDENTITY_TOKEN|WEB_IDENTITY_TOKEN|PRIVATE_?KEY|(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)(?:_|$))/;

function nonEmptyEnv(env: Record<string, unknown>, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function hasTransportInterceptionEnv(env: Record<string, unknown>): boolean {
  return Object.entries(env).some(([key, value]) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEY_SET.has(key.toUpperCase()),
  );
}

function classifyPrefixedProviderEnv(
  adapterType: string,
  env: Record<string, unknown>,
): SubscriptionBillingPolicyFailureCode | null {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.trim().length === 0) continue;

    if (adapterType === "codex_local" && key.startsWith("OPENAI_")) {
      return CREDENTIAL_ENV_NAME_FRAGMENT.test(key)
        ? "metered_credential_present"
        : "metered_provider_selected";
    }
    if (
      adapterType === "codex_local" &&
      key.startsWith("CODEX_") &&
      !CODEX_SUBSCRIPTION_ALLOWED_ENV_KEYS.has(key)
    ) {
      return CREDENTIAL_ENV_NAME_FRAGMENT.test(key)
        ? "metered_credential_present"
        : "metered_provider_selected";
    }

    if (adapterType !== "claude_local") continue;
    if (key === "CLAUDE_CODE_OAUTH_TOKEN") continue;
    if (key.startsWith("ANTHROPIC_")) {
      if (CLAUDE_SUBSCRIPTION_ALLOWED_ANTHROPIC_ENV_KEYS.has(key)) continue;
      return CREDENTIAL_ENV_NAME_FRAGMENT.test(key)
        ? "metered_credential_present"
        : "metered_provider_selected";
    }
    if (key.startsWith("CLAUDE_CODE_USE_")) return "metered_provider_selected";
    if (key.startsWith("CLAUDE_CODE_") && /(?:SETTINGS|CONFIG|PROVIDER|WRAPPER|LAUNCHER)/.test(key)) {
      return "metered_provider_selected";
    }
    if (
      key.startsWith("CLAUDE_") &&
      /(?:API|AUTH|OAUTH|TOKEN|BASE_URL|PROXY|GATEWAY)/.test(key)
    ) {
      return CREDENTIAL_ENV_NAME_FRAGMENT.test(key)
        ? "metered_credential_present"
        : "metered_provider_selected";
    }
    if (CLAUDE_PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      return CREDENTIAL_ENV_NAME_FRAGMENT.test(key)
        ? "metered_credential_present"
        : "metered_provider_selected";
    }
  }
  return null;
}

/** Shared, deterministic provider/injection classifier. Authentication proof stays adapter-specific. */
export function classifySubscriptionOnlyProviderPolicy(input: {
  adapterType: string;
  config: Record<string, unknown>;
  env: Record<string, unknown>;
  configuredEnv?: Record<string, unknown>;
}): SubscriptionBillingPolicyFailureCode | null {
  if (!isSubscriptionOnlyBillingPolicy(input.config)) return null;
  const keys = SUBSCRIPTION_POLICY_ENV_KEYS[input.adapterType as keyof typeof SUBSCRIPTION_POLICY_ENV_KEYS];
  if (!keys) return "subscription_environment_unsupported";
  if (SUBSCRIPTION_POLICY_INJECTION_ENV_KEYS.some((key) => nonEmptyEnv(input.configuredEnv ?? {}, key))) {
    return "metered_provider_selected";
  }
  if (SUBSCRIPTION_POLICY_FINAL_ENV_INJECTION_KEYS.some((key) => nonEmptyEnv(input.env, key))) {
    return "metered_provider_selected";
  }
  if (hasTransportInterceptionEnv(input.env)) return "metered_provider_selected";
  if (keys.credentials.some((key) => nonEmptyEnv(input.env, key))) return "metered_credential_present";
  if (keys.providers.some((key) => nonEmptyEnv(input.env, key))) return "metered_provider_selected";
  const prefixedProviderFailure = classifyPrefixedProviderEnv(input.adapterType, input.env);
  if (prefixedProviderFailure) return prefixedProviderFailure;
  const command = typeof input.config.command === "string" ? input.config.command.trim() : input.adapterType === "claude_local" ? "claude" : "codex";
  const stock = input.adapterType === "claude_local" ? "claude" : "codex";
  const hasAgentCommand = [input.config.agentCommand, input.config.acpAgentCommand]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  const hasProviderConfig = [input.config.modelProvider, input.config.baseUrl]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  const rawArgs = [...(Array.isArray(input.config.args) ? input.config.args : []), ...(Array.isArray(input.config.extraArgs) ? input.config.extraArgs : [])];
  const sandboxCommand = typeof input.config.filesystemSandboxCommand === "string"
    ? input.config.filesystemSandboxCommand.trim()
    : "";
  const hasExecutableOverride = sandboxCommand.length > 0 && sandboxCommand !== "bwrap";
  const hasStateDirOverride = [input.config.stateDir, input.config.acpStateDir]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  return command !== stock || hasAgentCommand || hasProviderConfig || rawArgs.length > 0 || hasExecutableOverride || hasStateDirOverride
    ? "metered_provider_selected"
    : null;
}

export function isSubscriptionOnlyBillingPolicy(config: Record<string, unknown>): boolean {
  return config.billingPolicy === SUBSCRIPTION_ONLY_BILLING_POLICY;
}

export class SubscriptionBillingPolicyFailure extends Error {
  readonly code: SubscriptionBillingPolicyFailureCode;
  readonly evidence: Record<string, unknown> | null;

  constructor(code: SubscriptionBillingPolicyFailureCode, message: string, evidence?: Record<string, unknown> | null) {
    super(message);
    this.name = "SubscriptionBillingPolicyFailure";
    this.code = code;
    this.evidence = evidence ?? null;
  }
}

export function isSubscriptionBillingPolicyFailure(
  error: unknown,
): error is SubscriptionBillingPolicyFailure {
  return error instanceof SubscriptionBillingPolicyFailure;
}
