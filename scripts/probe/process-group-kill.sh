#!/usr/bin/env bash
#
# Verify the process-group wrapper used by project.exec against the same Debian userland as the
# computerd image. This is local evidence only; it makes no Cloudflare API call.
#
# Usage: scripts/probe/process-group-kill.sh [image]
# Environment: CONTAINER_TOOL (default: docker)

set -euo pipefail

CONTAINER_TOOL="${CONTAINER_TOOL:-docker}"
IMAGE="${1:-debian:stable-slim}"

if ! command -v "$CONTAINER_TOOL" >/dev/null 2>&1; then
  printf 'Container tool not found: %s\n' "$CONTAINER_TOOL" >&2
  exit 1
fi

printf 'Process-group probe: %s using %s\n' "$IMAGE" "$CONTAINER_TOOL"
PROBE_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/cf-stumble-process-group.XXXXXX")"
trap 'rm -f "$PROBE_SCRIPT"' EXIT
cat >"$PROBE_SCRIPT" <<'PROBE'
set -eu

shell_quote() {
  value=$1
  value=$(printf '%s' "$value" | sed "s/'/'\"'\"'/g")
  printf "'%s'" "$value"
}

process_group_command() {
  command=$1
  quoted_command=$(shell_quote "$command")
  body="trap 'kill -s KILL 0' TERM INT HUP; /bin/sh -c ${quoted_command} & wait \$!"
  printf 'exec setsid /bin/sh -c %s' "$(shell_quote "$body")"
}

printf 'setsid: %s\n' "$(command -v setsid)"

if normal_output=$(sh -c "$(process_group_command 'printf ok; exit 7')" 2>/tmp/process-group-stderr); then
  normal_code=$?
else
  normal_code=$?
fi
[ "$normal_output" = ok ]
[ "$normal_code" -eq 7 ]
[ ! -s /tmp/process-group-stderr ]
printf 'normal exit: code=%s stdout=%s\n' "$normal_code" "$normal_output"

rm -f /tmp/process-group-child
sh -c "$(process_group_command 'sleep 300 & echo $! >/tmp/process-group-child; wait')" &
leader=$!
tries=0
while [ ! -s /tmp/process-group-child ]; do
  tries=$((tries + 1))
  [ "$tries" -lt 20 ] || { printf 'child pid was not published\n' >&2; exit 1; }
  sleep 0.05
done
child=$(cat /tmp/process-group-child)
kill -TERM "$leader" 2>/dev/null || true
wait "$leader" 2>/dev/null || true
if kill -0 "$child" 2>/dev/null; then
  printf 'FAIL: child survived process-group kill (pid %s)\n' "$child" >&2
  kill -KILL "$child" 2>/dev/null || true
  exit 1
fi
printf 'tree kill: leader and child stopped (child=%s)\n' "$child"

rm -f /tmp/process-group-detached
sh -c "$(process_group_command 'sleep 300 & echo $! >/tmp/process-group-detached')"
detached=$(cat /tmp/process-group-detached)
if kill -0 "$detached" 2>/dev/null; then
  printf 'normal detached child survives as intended (pid=%s)\n' "$detached"
  kill -KILL "$detached" 2>/dev/null || true
else
  printf 'FAIL: normal detached child did not survive\n' >&2
  exit 1
fi
PROBE
"$CONTAINER_TOOL" run --rm --entrypoint /bin/sh -v "$PROBE_SCRIPT:/probe.sh:ro" "$IMAGE" /probe.sh
