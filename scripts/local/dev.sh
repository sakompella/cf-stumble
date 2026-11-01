#!/usr/bin/env bash
set -euo pipefail

exec pnpm exec cf dev "$@"
