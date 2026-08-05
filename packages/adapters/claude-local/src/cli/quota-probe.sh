#!/usr/bin/env bash
#
# Portable Claude quota probe.
#
# The script reads the Claude OAuth access token, calls the Anthropic usage
# endpoint, and prints one JSON envelope to standard output. A host reads that
# envelope with `parseSandboxQuotaEnvelope`. The envelope carries the same five
# windows as the host function `fetchClaudeQuota`.
#
# The script obeys the security conditions of the design review:
#  - It calls only the one allowlisted URL. It disables `.curlrc`, forbids
#    redirects, keeps TLS verification on, ignores every proxy environment
#    value, and sets bounded timeouts and a response-size cap.
#  - It keeps the bearer token out of the process argument list. It passes the
#    Authorization header to `curl` through a configuration file on standard
#    input. It turns shell trace off and never prints the token.
#
# Token source order (decision DP6): the script reads the token from an
# environment variable first, then from the on-disk credential file.
#  1. CLAUDE_CODE_OAUTH_TOKEN
#  2. CLAUDE_OAUTH_TOKEN
#  3. <config dir>/.credentials.json, then <config dir>/credentials.json,
#     at the JSON path `.claudeAiOauth.accessToken`.
# The config dir is CLAUDE_CONFIG_DIR, else $HOME/.claude.
#
# Modes:
#  (default)     Read the token, call the endpoint, print the envelope.
#  --map-stdin   Read an OAuth usage response from standard input and print the
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
readonly USAGE_URL="https://api.anthropic.com/api/oauth/usage"
readonly ANTHROPIC_BETA="oauth-2025-04-20"
readonly CONNECT_TIMEOUT_SEC=10
readonly MAX_TIME_SEC=30
# Response-size cap in bytes. The usage response is small; a larger body is a
# fault.
readonly MAX_RESPONSE_BYTES=262144

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

# The jq program that maps an Anthropic usage response to the aggregated
# ProviderQuotaResult. It mirrors the host function `fetchClaudeQuota`.
readonly MAP_PROGRAM='
# Convert a utilization value to a 0-100 integer percent. Accept a 0-1 fraction
# or a 0-100 percent, the same way the host toPercent does.
def to_percent(u):
  if u == null then null
  else ([100, ((if u < 1 then u * 100 else u end) | round)] | min)
  end;

# Format a cents value as a currency string, close to Intl en-US currency.
def money(cents; code):
  ((code // "USD") | ascii_upcase) as $c
  | ({ "USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥" }[$c] // ($c + " ")) as $prefix
  | (cents | round) as $ct
  | (($ct / 100) | floor) as $dollars
  | ($ct - ($dollars * 100)) as $rem
  | ($prefix + ($dollars | tostring) + "." + (if $rem < 10 then "0" else "" end) + ($rem | tostring));

# Map a plain rate-limit window. Drop it when the field is absent or null.
def window(w; lbl):
  if w == null then empty
  else { label: lbl, usedPercent: to_percent(w.utilization), resetsAt: (w.resets_at // null), valueLabel: null, detail: null }
  end;

# Map the extra-usage pool. Drop it when the field is absent or null.
def extra_window(e):
  if e == null then empty
  elif (e.is_enabled == false) then
    { label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: "Not enabled", detail: "Extra usage not enabled" }
  else
    (e.monthly_limit) as $ml
    | (e.used_credits) as $uc
    | (if ($ml | type) == "number" and ($uc | type) == "number"
        then (money($uc; e.currency) + " / " + money($ml; e.currency))
        else null end) as $value_label
    | { label: "Extra usage", usedPercent: to_percent(e.utilization), resetsAt: null, valueLabel: $value_label, detail: "Monthly extra usage pool" }
  end;

{
  ok: true,
  timestamp: $ts,
  tokenAvailable: true,
  aggregated: {
    provider: "anthropic",
    source: "anthropic-oauth",
    ok: true,
    windows: [
      window(.five_hour; "Current session"),
      window(.seven_day; "Current week (all models)"),
      window(.seven_day_sonnet; "Current week (Sonnet only)"),
      window(.seven_day_opus; "Current week (Opus only)"),
      extra_window(.extra_usage)
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
        { provider: "anthropic", ok: false, error: $err, windows: [] }
        + (if $fam == "" then {} else { errorFamily: $fam } end)
      )
    }'
}

# Map an OAuth usage response text to the envelope. Fail closed on bad JSON.
map_usage_response() {
  response_text="$1"
  if ! printf '%s' "${response_text}" | jq empty >/dev/null 2>&1; then
    emit_error "The Anthropic usage response was not valid JSON." "transient_upstream" true
    return 1
  fi
  printf '%s' "${response_text}" | jq --arg ts "$(iso_now)" "${MAP_PROGRAM}"
}

read_token_from_file() {
  cred_path="$1"
  if [ -f "${cred_path}" ]; then
    token_value="$(jq -r '.claudeAiOauth.accessToken // empty' "${cred_path}" 2>/dev/null || true)"
    if [ -n "${token_value}" ]; then
      printf '%s' "${token_value}"
      return 0
    fi
  fi
  return 1
}

resolve_token() {
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    printf '%s' "${CLAUDE_CODE_OAUTH_TOKEN}"
    return 0
  fi
  if [ -n "${CLAUDE_OAUTH_TOKEN:-}" ]; then
    printf '%s' "${CLAUDE_OAUTH_TOKEN}"
    return 0
  fi
  config_dir="${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}"
  for filename in ".credentials.json" "credentials.json"; do
    if read_token_from_file "${config_dir}/${filename}"; then
      return 0
    fi
  done
  return 1
}

run_default_mode() {
  if ! token="$(resolve_token)"; then
    emit_error "No Claude OAuth access token is available." "" false
    return 1
  fi

  BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/claude-quota-probe.XXXXXX")" || {
    emit_error "Could not create a temporary file for the quota probe." "transient_upstream" true
    return 1
  }

  # Pass the Authorization header through a curl configuration file on standard
  # input. The token never enters the argument list. `printf` is a shell builtin,
  # so the token never becomes a separate process argument.
  http_code="$(
    printf 'header = "Authorization: Bearer %s"\n' "${token}" | curl \
      --disable \
      --config - \
      --silent \
      --show-error \
      --max-redirs 0 \
      --noproxy '*' \
      --connect-timeout "${CONNECT_TIMEOUT_SEC}" \
      --max-time "${MAX_TIME_SEC}" \
      --max-filesize "${MAX_RESPONSE_BYTES}" \
      --header "anthropic-beta: ${ANTHROPIC_BETA}" \
      --write-out '%{http_code}' \
      --output "${BODY_FILE}" \
      "${USAGE_URL}"
  )"
  curl_status=$?

  if [ "${curl_status}" -ne 0 ]; then
    emit_error "Could not reach the Anthropic usage endpoint." "transient_upstream" true
    return 1
  fi

  case "${http_code}" in
    2??) ;;
    401 | 403)
      emit_error "The Claude access token is not valid for the usage endpoint." "refresh_token_expired" true
      return 1
      ;;
    429)
      emit_error "The Anthropic usage endpoint is rate limited." "provider_quota" true
      return 1
      ;;
    *)
      emit_error "The Anthropic usage endpoint returned an error." "transient_upstream" true
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
