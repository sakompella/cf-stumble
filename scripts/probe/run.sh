#!/usr/bin/env bash
#
# Minimal paid-probe lever for cf-stumble.
#
# Deploys a disposable Worker that proves the Workers AI model route,
# records redacted evidence, and tears down all created resources.
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN    wrangler authentication, or an existing wrangler login
#   CLOUDFLARE_ACCOUNT_ID   target Cloudflare account
#   PROBE_BEARER_SECRET     single-run bearer token for the probe endpoint
#
# Cleanup order (on success AND failure):
#   1. Durable Object / workspace data  (none in this minimal probe)
#   2. The disposable Worker
#   3. Verify the Worker is gone; exit 1 if it is not
#

set -euo pipefail

##############################################################################
# Fail fast: required environment
##############################################################################

# Either an API token or an existing wrangler login authenticates this run.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && ! wrangler whoami >/dev/null 2>&1; then
  printf 'No Cloudflare credential. Set CLOUDFLARE_API_TOKEN or run: wrangler login\n' >&2
  exit 1
fi
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID must be set}"
: "${PROBE_BEARER_SECRET:?PROBE_BEARER_SECRET must be set}"

##############################################################################
# Fail fast: required tools
##############################################################################

for cmd in wrangler curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Required tool not found: %s\n' "$cmd" >&2
    exit 1
  fi
done

##############################################################################
# Unique identifiers for this run
##############################################################################

TIMESTAMP="$(date +%s)"
WORKER_NAME="cf-stumble-probe-model-${TIMESTAMP}"
PROBE_RUN_ID="probe-${TIMESTAMP}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_DIR="${SCRIPT_DIR}/manifests"
EVIDENCE_DIR="${SCRIPT_DIR}/evidence"
mkdir -p "$MANIFEST_DIR" "$EVIDENCE_DIR"

MANIFEST="${MANIFEST_DIR}/manifest-${TIMESTAMP}.json"
EVIDENCE="${EVIDENCE_DIR}/result-${TIMESTAMP}.json"
CLEANUP_LOG="${EVIDENCE_DIR}/cleanup-${TIMESTAMP}.log"

# Temp files removed in all exit paths.
WRANGLER_CONFIG=""
WORKER_FILE=""
SECRET_FILE=""

##############################################################################
# Write run manifest (before any resource creation)
##############################################################################

jq -n \
  --arg worker "$WORKER_NAME" \
  --arg ts     "$TIMESTAMP" \
  --arg runid  "$PROBE_RUN_ID" \
  '{
    worker_name: $worker,
    container_app_ids: [],
    timestamp:   $ts,
    probe_run_id: $runid
  }' > "$MANIFEST"

printf 'Manifest written: %s\n' "$MANIFEST"

##############################################################################
# Write disposable Worker source to a temp file
##############################################################################

WORKER_FILE="$(mktemp "${TMPDIR:-/tmp}/probe-worker-XXXXXX.js")"

cat > "$WORKER_FILE" << 'WORKER_EOF'
export default {
  async fetch(request, env) {
    if (!env.PROBE_SECRET) {
      return new Response("PROBE_SECRET not configured", { status: 500 });
    }
    var auth = (request.headers.get("Authorization") || "");
    if (auth !== "Bearer " + env.PROBE_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (!env.PROBE_RUN_ID) {
      return new Response("PROBE_RUN_ID not configured", { status: 500 });
    }

    var evidence = {
      model_ok: false,
      model_redacted_summary: "",
      probe_run_id: env.PROBE_RUN_ID,
      timestamp: new Date().toISOString()
    };

    try {
      var result = await env.AI.run("@cf/zai-org/glm-5.3-flash", {
        messages: [
          { role: "system", content: "You are a coding assistant." },
          { role: "user", content: "Respond with one word." }
        ],
        reasoning_effort: "low"
      });
      evidence.model_ok = result !== null && typeof result === "object";
      evidence.model_redacted_summary = evidence.model_ok
        ? "model_responded"
        : "model_returned_falsy";
    } catch (e) {
      evidence.model_redacted_summary = "model_call_failed";
    }

    return Response.json(evidence);
  }
};
WORKER_EOF

##############################################################################
# Generate disposable wrangler config
##############################################################################

WRANGLER_CONFIG="$(mktemp "${TMPDIR:-/tmp}/probe-wrangler-XXXXXX.jsonc")"

jq -n \
  --arg name   "$WORKER_NAME" \
  --arg main   "$WORKER_FILE" \
  --arg runid  "$PROBE_RUN_ID" \
  '{
    name:               $name,
    main:               $main,
    compatibility_date: "2025-01-01",
    ai:                 { binding: "AI" },
    vars:               { PROBE_RUN_ID: $runid }
  }' > "$WRANGLER_CONFIG"

##############################################################################
# Cleanup: runs on success AND failure via trap
##############################################################################

CLEANUP_RAN=false

cleanup() {
  if "$CLEANUP_RAN"; then return 0; fi
  CLEANUP_RAN=true
  set +e

  printf '=== Cleanup start ===\n' | tee -a "$CLEANUP_LOG"

  # Step 1: Durable Object / workspace data (none in this minimal probe).
  printf 'Step 1/3: No DO or workspace data in this probe.\n' | tee -a "$CLEANUP_LOG"

  # Step 2: Delete the disposable Worker.
  if [ -n "$WRANGLER_CONFIG" ] && [ -f "$WRANGLER_CONFIG" ]; then
    printf 'Step 2/3: Deleting Worker %s\n' "$WORKER_NAME" | tee -a "$CLEANUP_LOG"
    printf 'y\n' | wrangler delete --config "$WRANGLER_CONFIG" >>"$CLEANUP_LOG" 2>&1 || true
  fi

  # Step 3: Verify the Worker is gone.
  local incomplete=false
  if wrangler deployments list --name "$WORKER_NAME" >/dev/null 2>&1; then
    printf 'STILL EXISTS: Worker %s\n' "$WORKER_NAME" | tee -a "$CLEANUP_LOG"
    incomplete=true
  else
    printf 'Verified gone: Worker %s\n' "$WORKER_NAME" | tee -a "$CLEANUP_LOG"
  fi

  rm -f "$WRANGLER_CONFIG" "$WORKER_FILE" "$SECRET_FILE" 2>/dev/null

  if "$incomplete"; then
    printf '=== CLEANUP INCOMPLETE ===\n' | tee -a "$CLEANUP_LOG"
    exit 1
  fi

  printf '=== Cleanup complete ===\n' | tee -a "$CLEANUP_LOG"
}

trap cleanup EXIT

##############################################################################
# Deploy the disposable Worker
##############################################################################

printf 'Deploying: %s\n' "$WORKER_NAME"
DEPLOY_OUTPUT="$(wrangler deploy --config "$WRANGLER_CONFIG" 2>&1)"
printf '%s\n' "$DEPLOY_OUTPUT"

WORKER_URL="$(printf '%s' "$DEPLOY_OUTPUT" | grep -o 'https://[^[:space:]]*' | head -1)"
if [ -z "$WORKER_URL" ]; then
  printf 'Failed to extract Worker URL from deploy output.\n' >&2
  exit 1
fi
printf 'Worker URL: %s\n' "$WORKER_URL"

##############################################################################
# Set the bearer secret (from file, never as a command argument)
##############################################################################

SECRET_FILE="$(mktemp "${TMPDIR:-/tmp}/probe-secret-XXXXXX")"
printf '%s' "$PROBE_BEARER_SECRET" > "$SECRET_FILE"
wrangler secret put PROBE_SECRET --config "$WRANGLER_CONFIG" < "$SECRET_FILE"
rm -f "$SECRET_FILE"
SECRET_FILE=""

##############################################################################
# Invoke the probe endpoint
##############################################################################

printf 'Invoking probe…\n'
# A new deployment is not routable instantly, so a first non-200 is not a probe failure.
HTTP_CODE=000
for attempt in 1 2 3 4 5 6; do
  HTTP_CODE="$(curl -s -o "$EVIDENCE" -w '%{http_code}' \
    -H "Authorization: Bearer ${PROBE_BEARER_SECRET}" \
    "${WORKER_URL}/probe" || printf '000')"
  if [ "$HTTP_CODE" = "200" ]; then
    break
  fi
  printf 'Attempt %s returned HTTP %s. Retrying.\n' "$attempt" "$HTTP_CODE"
  sleep 5
done

if [ "$HTTP_CODE" != "200" ]; then
  printf 'Probe returned HTTP %s after retries.\n' "$HTTP_CODE" >&2
  head -c 2000 "$EVIDENCE" >&2 || true
  exit 1
fi

printf 'Evidence written: %s\n' "$EVIDENCE"

##############################################################################
# Assert results
##############################################################################

MODEL_OK="$(jq -r '.model_ok' "$EVIDENCE")"

if [ "$MODEL_OK" != "true" ]; then
  printf 'PROBE FAILED  model_ok=%s\n' "$MODEL_OK" >&2
  exit 1
fi

printf 'Probe passed. The model route answered.\n'
# Cleanup runs via trap EXIT.
