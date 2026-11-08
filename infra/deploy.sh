#!/usr/bin/env bash

set -euo pipefail

stage=prod
if [ $# -gt 0 ] && [[ $1 != -* ]]; then
  stage=$1
  shift
fi

cd "$(dirname "$0")/.."
pnpm run install:infra
pnpm run build:page
pnpm run build:shell-modules
exec pnpm alchemy deploy --config infra/alchemy.run.ts --stage "$stage" "$@"
