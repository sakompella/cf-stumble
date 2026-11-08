#!/usr/bin/env bash

set -euo pipefail

engine="${STUMBLE_ENGINE:?}"
image="${STUMBLE_IMAGE:-$("$(dirname "$0")/../../../infra/workspace-image/image-ref.sh")}"
network=(${STUMBLE_NETWORK:+--network "$STUMBLE_NETWORK"})
name="stumble-${STUMBLE_CONTAINER}"

case "$STUMBLE_JOB" in
  start)
    "$engine" image inspect "$image" >/dev/null 2>&1 ||
      "$engine" pull --platform linux/amd64 "$image" >&2
    "$engine" rm -f "$name" >/dev/null 2>&1 || true
    "$engine" run -d --rm --name "$name" \
      ${network[@]+"${network[@]}"} \
      --platform linux/amd64 \
      --add-host "computer.internal:host-gateway" \
      --env-file "$STUMBLE_ENV_FILE" \
      -p 127.0.0.1::8080 \
      "$image" >/dev/null
    "$engine" port "$name" 8080/tcp | head -n 1
    ;;
  stop | delete)
    "$engine" rm -f "$name" >/dev/null 2>&1 || true
    ;;
  wait)
    "$engine" wait "$name"
    ;;
  *)
    echo "unknown job: $STUMBLE_JOB" >&2
    exit 2
    ;;
esac
