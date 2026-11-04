#!/usr/bin/env bash

set -euo pipefail

STUMBLE_ENGINE=podman STUMBLE_NETWORK=pasta:--map-host-loopback,169.254.1.2 \
  exec "$(dirname "$0")/container-dispatch.sh"
