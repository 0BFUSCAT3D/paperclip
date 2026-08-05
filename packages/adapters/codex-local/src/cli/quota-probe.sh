#!/usr/bin/env bash
#
# Portable Codex quota probe.
#
# The script reads the Codex OAuth access token, calls the ChatGPT WHAM usage
# endpoint, and prints one JSON envelope to standard output. A host reads that
# envelope with `parseSandboxQuotaEnvelope`. The envelope carries the same
# windows as the host function `fetchCodexQuota`.
#
# The script obeys the security conditions of the design review:
#  - It calls only the one allowlisted URL. It disables `.curlrc`, forbids
#    redirects, keeps TLS verification on, ignores every proxy environment
#    value, and sets bounded timeouts and a response-size cap.
#  - It keeps the bearer token and the account identifier out of the process
#    argument list. It passes the `Authorization` and `ChatGPT-Account-Id`
#    headers to `curl` through a configuration file on standard input. It turns
#    shell trace off and never prints the token.
#
# Token source order (decision DP6): the script reads the token from an
# environment variable first, then from the on-disk credential file.
#  1. CODEX_ACCESS_TOKEN
#  2. <codex home>/auth.json, at the JSON path `.accessToken` (legacy) or
#     `.tokens.access_token` (modern).
# The codex home is CODEX_HOME, else $HOME/.codex. There is no account-identifier
# environment variable, so the script reads the account identifier only from the
# file, at `.accountId` (legacy) or `.tokens.account_id` (modern).
#
# Modes:
#  (default)     Read the token, call the endpoint, print the envelope.
#  --map-stdin   Read a WHAM usage response from standard input and print the
#                envelope. This mode runs the pure mapping only. It does not read
#                a token and does not call the network. A test uses this mode to
#                prove the mapping without the network. This mode does not read a
#                URL or a proxy value from the environment, so it keeps the
#                network path of the default mode unchanged.

set -u
set +x
umask 077

# The one allowlisted endpoint. The script never reads this URL from the
# environment.
readonly USAGE_URL="https://chatgpt.com/backend-api/wham/usage"
readonly CONNECT_TIMEOUT_SEC=10
readonly MAX_TIME_SEC=30
# Response-size cap in bytes. The usage response is small; a larger body is a
# fault.
readonly MAX_RESPONSE_BYTES=262144

# The token and the account identifier that resolve_token sets. The account
# identifier is not a secret, but the script keeps it out of the argument list.
RESOLVED_TOKEN=""
RESOLVED_ACCOUNT_ID=""

BODY_FILE=""
cleanup() {
  # Delete the temporary response file. The file never holds the token.
  if [ -n "${BODY_FILE}" ]; then
    rm -f "${BODY_FILE}"
  fi
}
trap cleanup EXIT INT TERM

iso_now() {
  date -u +%Y-%m-%dT%H:%M:%S.000Z
}

# The jq program that maps a WHAM usage response to the aggregated
# ProviderQuotaResult. It mirrors the host function `fetchCodexQuota`.
readonly MAP_PROGRAM='
# Coerce a value to a number, the same way the host relies on JavaScript
# coercion. The WHAM endpoint returns some numeric fields as strings (for
# example credits.balance is "0"). A number passes through. A numeric string
# converts. Any other value maps to null.
def num(v):
  if v == null then null
  elif (v | type) == "number" then v
  elif (v | type) == "string" then (v | try tonumber catch null)
  else null
  end;

# Convert a used-percent value to a 0-100 integer percent. Accept a 0-1 fraction
# or a 0-100 percent, the same way the host normalizeCodexUsedPercent does.
def to_percent(u0):
  (num(u0)) as $u
  | if $u == null then null
    else ([100, ((if $u < 1 then $u * 100 else $u end) | round)] | min)
    end;

# Convert a reset value to an ISO string. A number is unix seconds; the host
# uses new Date(value*1000).toISOString(), so append the .000 milliseconds. A
# string passes through. An absent value maps to null.
def reset_iso(w):
  (w.reset_at) as $r
  | if $r == null then null
    elif ($r | type) == "number" then (($r | todate) | sub("Z$"; ".000Z"))
    else $r
    end;

# Format a cents balance as a "$<dollars>.<cents> remaining" string, close to
# the host `$${(balance/100).toFixed(2)} remaining`. An absent balance maps to
# "N/A".
def credit_label(bal):
  (num(bal)) as $n
  | if $n == null then "N/A"
  else
    ($n | round) as $ct
    | (($ct / 100) | floor) as $dollars
    | ($ct - ($dollars * 100)) as $rem
    | ("$" + ($dollars | tostring) + "." + (if $rem < 10 then "0" else "" end) + ($rem | tostring) + " remaining")
  end;

# Map a rate-limit window. Drop it when the field is absent or null.
def window(w; lbl):
  if w == null then empty
  else { label: lbl, usedPercent: to_percent(w.used_percent), resetsAt: reset_iso(w), valueLabel: null, detail: null }
  end;

# Map the credits pool. Drop it when the field is absent, null, or unlimited.
def credits_window(c):
  if c == null or (c.unlimited == true) then empty
  else { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: credit_label(c.balance), detail: null }
  end;

{
  ok: true,
  timestamp: $ts,
  tokenAvailable: true,
  aggregated: {
    provider: "openai",
    source: "codex-wham",
    ok: true,
    windows: [
      window(.rate_limit.primary_window; "5h limit"),
      window(.rate_limit.secondary_window; "Weekly limit"),
      credits_window(.credits)
    ]
  }
}
'

# Print an ok:false envelope. Never print the token. The error family is bounded;
# an empty family prints no errorFamily field.
emit_error() {
  message="$1"
  family="${2:-}"
  token_available="${3:-false}"
  jq -n \
    --arg ts "$(iso_now)" \
    --arg err "$message" \
    --arg fam "$family" \
    --argjson tok "$token_available" '
    {
      ok: false,
      timestamp: $ts,
      tokenAvailable: $tok,
      aggregated: (
        { provider: "openai", ok: false, error: $err, windows: [] }
        + (if $fam == "" then {} else { errorFamily: $fam } end)
      )
    }'
}

# Map a WHAM usage response text to the envelope. Fail closed on bad JSON.
map_usage_response() {
  response_text="$1"
  if ! printf '%s' "${response_text}" | jq empty >/dev/null 2>&1; then
    emit_error "The ChatGPT WHAM usage response was not valid JSON." "transient_upstream" true
    return 1
  fi
  printf '%s' "${response_text}" | jq --arg ts "$(iso_now)" "${MAP_PROGRAM}"
}

resolve_token() {
  RESOLVED_TOKEN=""
  RESOLVED_ACCOUNT_ID=""
  if [ -n "${CODEX_ACCESS_TOKEN:-}" ]; then
    RESOLVED_TOKEN="${CODEX_ACCESS_TOKEN}"
    return 0
  fi
  codex_home="${CODEX_HOME:-${HOME:-}/.codex}"
  auth_path="${codex_home}/auth.json"
  if [ -f "${auth_path}" ]; then
    token_value="$(jq -r '.accessToken // .tokens.access_token // empty' "${auth_path}" 2>/dev/null || true)"
    if [ -n "${token_value}" ]; then
      RESOLVED_TOKEN="${token_value}"
      RESOLVED_ACCOUNT_ID="$(jq -r '.accountId // .tokens.account_id // empty' "${auth_path}" 2>/dev/null || true)"
      return 0
    fi
  fi
  return 1
}

run_default_mode() {
  if ! resolve_token; then
    emit_error "No Codex OAuth access token is available." "" false
    return 1
  fi

  BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/codex-quota-probe.XXXXXX")" || {
    emit_error "Could not create a temporary file for the quota probe." "transient_upstream" true
    return 1
  }

  # Pass the Authorization header, and the account-identifier header when it
  # exists, through a curl configuration file on standard input. The token never
  # enters the argument list. `printf` is a shell builtin, so the token never
  # becomes a separate process argument.
  http_code="$(
    {
      printf 'header = "Authorization: Bearer %s"\n' "${RESOLVED_TOKEN}"
      if [ -n "${RESOLVED_ACCOUNT_ID}" ]; then
        printf 'header = "ChatGPT-Account-Id: %s"\n' "${RESOLVED_ACCOUNT_ID}"
      fi
    } | curl \
      --disable \
      --config - \
      --silent \
      --show-error \
      --max-redirs 0 \
      --noproxy '*' \
      --connect-timeout "${CONNECT_TIMEOUT_SEC}" \
      --max-time "${MAX_TIME_SEC}" \
      --max-filesize "${MAX_RESPONSE_BYTES}" \
      --write-out '%{http_code}' \
      --output "${BODY_FILE}" \
      "${USAGE_URL}"
  )"
  curl_status=$?

  if [ "${curl_status}" -ne 0 ]; then
    emit_error "Could not reach the ChatGPT WHAM usage endpoint." "transient_upstream" true
    return 1
  fi

  case "${http_code}" in
    2??) ;;
    401 | 403)
      emit_error "The Codex access token is not valid for the usage endpoint." "refresh_token_expired" true
      return 1
      ;;
    429)
      emit_error "The ChatGPT WHAM usage endpoint is rate limited." "provider_quota" true
      return 1
      ;;
    *)
      emit_error "The ChatGPT WHAM usage endpoint returned an error." "transient_upstream" true
      return 1
      ;;
  esac

  # Read a bounded number of bytes, so a large body cannot exhaust host memory.
  response_text="$(head -c "${MAX_RESPONSE_BYTES}" "${BODY_FILE}")"
  if ! map_usage_response "${response_text}"; then
    return 1
  fi
  return 0
}

main() {
  mode="default"
  if [ "${1:-}" = "--map-stdin" ]; then
    mode="map-stdin"
  fi

  if [ "${mode}" = "map-stdin" ]; then
    stdin_text="$(cat)"
    if ! map_usage_response "${stdin_text}"; then
      return 1
    fi
    return 0
  fi

  if ! run_default_mode; then
    return 1
  fi
  return 0
}

main "$@"
exit $?
