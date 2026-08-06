#!/usr/bin/env bash
#
# Portable Claude quota probe.
#
# The script reads the Claude OAuth access token, calls the Anthropic usage
# endpoint, and prints one JSON envelope to standard output. A host reads that
# envelope with `parseSandboxQuotaEnvelope`. The envelope carries the same five
# windows as the host function `fetchClaudeQuota`.
#
# A setup-token lacks the scope the usage endpoint needs, so the usage endpoint
# returns HTTP 401 or 403. In that case the script uses a fallback source: it
# sends one minimal inference request to the messages endpoint and reads the
# rate-limit response headers. It maps the `anthropic-ratelimit-unified-*`
# headers to the same window shape and discards the response body. The script
# reaches the fallback only on 401 or 403. It does not fall back on 429, on a
# 5xx status, on a transport error, or on a missing token.
#
# The script obeys the security conditions of the design review:
#  - It calls only the two allowlisted URLs (the usage endpoint and the messages
#    endpoint). It disables `.curlrc`, forbids redirects, keeps TLS verification
#    on, ignores every proxy environment value, and sets bounded timeouts and a
#    response-size cap.
#  - It keeps the bearer token out of the process argument list. It passes the
#    Authorization header to `curl` through a configuration file on standard
#    input. It turns shell trace off and never prints the token.
#  - The fallback request body is a fixed literal: a small model, `max_tokens`
#    one, and a fixed non-sensitive prompt. The script interpolates no value
#    into the body. It maps only allowlisted headers and treats the numbers as
#    display values, never as an authorization input.
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
#  --map-headers-stdin
#                Read rate-limit header text from standard input and print the
#                envelope. This mode runs the pure header mapping only. It does
#                not read a token and does not call the network. A test uses this
#                mode to prove the fallback mapping without the network.

set -u
set +x
umask 077

# The allowlisted endpoints. The script never reads a URL from the environment.
# The usage endpoint is the primary source. The messages endpoint is the
# fallback source that the script reaches only after the usage endpoint returns
# HTTP 401 or 403 (the setup-token case).
readonly USAGE_URL="https://api.anthropic.com/api/oauth/usage"
readonly MESSAGES_URL="https://api.anthropic.com/v1/messages"
readonly ANTHROPIC_BETA="oauth-2025-04-20"
readonly ANTHROPIC_VERSION="2023-06-01"
readonly CONNECT_TIMEOUT_SEC=10
readonly MAX_TIME_SEC=30
# Response-size cap in bytes. The usage response is small; a larger body is a
# fault.
readonly MAX_RESPONSE_BYTES=262144

# The fixed request body of the messages fallback. The body carries no user
# data and no secret. The model is small and `max_tokens` is one, so the call
# is minimal. The script never interpolates a value into this literal.
readonly FALLBACK_MODEL="claude-3-5-haiku-20241022"
readonly FALLBACK_BODY='{"model":"claude-3-5-haiku-20241022","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}'

BODY_FILE=""
HEADER_FILE=""
cleanup() {
  # Delete the temporary files. Neither file ever holds the token.
  if [ -n "${BODY_FILE}" ]; then
    rm -f "${BODY_FILE}"
  fi
  if [ -n "${HEADER_FILE}" ]; then
    rm -f "${HEADER_FILE}"
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

# The jq program that maps the allowlisted Anthropic rate-limit headers to the
# aggregated ProviderQuotaResult. The fallback path uses it. It maps only the
# three unified windows the design review allows. It clamps a utilization value
# to 0-100 and drops a window with no valid field. It accepts a reset value only
# in a sane Unix-epoch range, so a malformed timestamp becomes null.
readonly MAP_HEADERS_PROGRAM='
def num(s): if (s | length) == 0 then null else (s | try tonumber catch null) end;

# Convert a utilization value to a 0-100 integer percent, clamped both ends.
def to_percent(u):
  if u == null then null
  else ([100, ([0, ((if u < 1 then u * 100 else u end) | round)] | max)] | min)
  end;

# Accept a reset value only as a sane Unix-epoch second count. The bounds hold
# roughly from year 2020 to year 2096. Drop any value outside that range.
def sane_reset(s):
  num(s) as $n
  | if $n == null then null
    elif ($n >= 1600000000 and $n <= 4000000000) then ($n | todate)
    else null
    end;

# Build one window. Drop it when neither the percent nor the reset is valid.
def win(lbl; u; r):
  (to_percent(num(u))) as $p
  | (sane_reset(r)) as $t
  | if $p == null and $t == null then empty
    else { label: lbl, usedPercent: $p, resetsAt: $t, valueLabel: null, detail: null }
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
      win("Current session"; $u5h; $r5h),
      win("Current week (all models)"; $u7d; $r7d),
      win("Current week (Sonnet only)"; $u7ds; $r7ds)
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

# Read one header value from header text on standard input. The function reads
# the value by an exact header name at the start of a line. It lowercases the
# text first, so it matches the header name without regard to letter case. The
# allowlisted header names and their values are lowercase and numeric, so the
# lowercase step does not change a value.
extract_header() {
  header_name="$1"
  tr 'A-Z' 'a-z' | sed -n "s/^${header_name}:[[:space:]]*//p" | tr -d '\r' | head -n1
}

# Map header text to the envelope. Read only the allowlisted unified headers.
# Fail closed when the text holds no usable header.
map_header_text() {
  header_text="$1"
  h_5h_util="$(printf '%s\n' "${header_text}" | extract_header 'anthropic-ratelimit-unified-5h-utilization')"
  h_5h_reset="$(printf '%s\n' "${header_text}" | extract_header 'anthropic-ratelimit-unified-5h-reset')"
  h_7d_util="$(printf '%s\n' "${header_text}" | extract_header 'anthropic-ratelimit-unified-7d-utilization')"
  h_7d_reset="$(printf '%s\n' "${header_text}" | extract_header 'anthropic-ratelimit-unified-7d-reset')"
  h_7ds_util="$(printf '%s\n' "${header_text}" | extract_header 'anthropic-ratelimit-unified-7d_sonnet-utilization')"
  h_7ds_reset="$(printf '%s\n' "${header_text}" | extract_header 'anthropic-ratelimit-unified-7d_sonnet-reset')"

  envelope="$(jq -n \
    --arg ts "$(iso_now)" \
    --arg u5h "${h_5h_util}" --arg r5h "${h_5h_reset}" \
    --arg u7d "${h_7d_util}" --arg r7d "${h_7d_reset}" \
    --arg u7ds "${h_7ds_util}" --arg r7ds "${h_7ds_reset}" \
    "${MAP_HEADERS_PROGRAM}")"

  window_count="$(printf '%s' "${envelope}" | jq '.aggregated.windows | length' 2>/dev/null || printf '0')"
  if [ "${window_count}" -eq 0 ]; then
    emit_error "The Anthropic messages fallback returned no usable rate-limit headers." "transient_upstream" true
    return 1
  fi
  printf '%s\n' "${envelope}"
  return 0
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

# The fallback source. The script reaches it only after the usage endpoint
# returns HTTP 401 or 403. The script sends one minimal inference request and
# reads only the rate-limit response headers. It discards the response body. It
# makes one call and never retries. The token stays out of the argument list.
run_header_fallback() {
  fallback_token="$1"

  # Tell the operator that the script used the quota-consuming fallback path.
  # The message carries no token and no response data.
  printf '%s\n' "note: the Anthropic usage endpoint refused the token; the probe used the messages header fallback (one minimal request)." >&2

  HEADER_FILE="$(mktemp "${TMPDIR:-/tmp}/claude-quota-probe-hdr.XXXXXX")" || {
    emit_error "Could not create a temporary file for the quota fallback." "transient_upstream" true
    return 1
  }

  # Send the fixed request body. The token goes through a curl configuration
  # file on standard input, so it never enters the argument list. The script
  # writes only the response headers to a file and discards the body.
  http_code="$(
    printf 'header = "Authorization: Bearer %s"\n' "${fallback_token}" | curl \
      --disable \
      --config - \
      --silent \
      --show-error \
      --max-redirs 0 \
      --noproxy '*' \
      --connect-timeout "${CONNECT_TIMEOUT_SEC}" \
      --max-time "${MAX_TIME_SEC}" \
      --max-filesize "${MAX_RESPONSE_BYTES}" \
      --request POST \
      --header "anthropic-beta: ${ANTHROPIC_BETA}" \
      --header "anthropic-version: ${ANTHROPIC_VERSION}" \
      --header "content-type: application/json" \
      --data "${FALLBACK_BODY}" \
      --dump-header "${HEADER_FILE}" \
      --write-out '%{http_code}' \
      --output /dev/null \
      "${MESSAGES_URL}"
  )"
  fallback_status=$?

  # The rate-limit headers appear on a success response and on many error
  # responses. Read the headers when the response carries any. A transport
  # failure writes no headers, so treat an empty header file as a hard failure.
  if [ ! -s "${HEADER_FILE}" ]; then
    if [ "${fallback_status}" -ne 0 ]; then
      emit_error "Could not reach the Anthropic messages endpoint for the quota fallback." "transient_upstream" true
    else
      emit_error "The Anthropic messages fallback returned no rate-limit headers." "transient_upstream" true
    fi
    return 1
  fi

  header_text="$(head -c "${MAX_RESPONSE_BYTES}" "${HEADER_FILE}")"
  if ! map_header_text "${header_text}"; then
    return 1
  fi
  return 0
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
      # The token is not valid for the usage endpoint. This is the setup-token
      # case: the token lacks the scope the usage endpoint needs. Fall back to
      # one inference call and read the rate-limit headers.
      if run_header_fallback "${token}"; then
        return 0
      fi
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
  elif [ "${1:-}" = "--map-headers-stdin" ]; then
    mode="map-headers-stdin"
  fi

  if [ "${mode}" = "map-stdin" ]; then
    stdin_text="$(cat)"
    if ! map_usage_response "${stdin_text}"; then
      return 1
    fi
    return 0
  fi

  if [ "${mode}" = "map-headers-stdin" ]; then
    # Read header text from standard input and print the envelope. This mode
    # runs the pure header mapping only. It reads no token and calls no network.
    stdin_text="$(cat)"
    if ! map_header_text "${stdin_text}"; then
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
