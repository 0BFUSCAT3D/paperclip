/**
 * Phase 6 never auto-approves model requests. Unsupported native requests are
 * declined explicitly; typed response materialization stays in existing
 * interaction/approval services.
 */
export function rejectUnsupportedNativeRuntimeRequest(requestKind: string) {
  return {
    accepted: false as const,
    code: "native_runtime_request_unsupported" as const,
    requestKind,
  };
}
