#!/usr/bin/env bash

set -euo pipefail

STUMBLE_ENGINE=docker exec "$(dirname "$0")/container-dispatch.sh"
