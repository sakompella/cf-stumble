#!/usr/bin/env bash

set -euo pipefail

image="${STUMBLE_IMAGE:-cf-stumble-workspace:orbs}"
name="stumble-${STUMBLE_CONTAINER}"

case "$STUMBLE_JOB" in
  start)
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --rm --name "$name" \
      --platform linux/amd64 \
      --add-host "computer.internal:host-gateway" \
      --env-file "$STUMBLE_ENV_FILE" \
      -p 127.0.0.1::8080 \
      "$image" >/dev/null
    docker port "$name" 8080/tcp | head -n 1
    ;;
  stop | delete)
    docker rm -f "$name" >/dev/null 2>&1 || true
    ;;
  wait)
    docker wait "$name"
    ;;
  *)
    echo "unknown job: $STUMBLE_JOB" >&2
    exit 2
    ;;
esac
