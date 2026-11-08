#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")"
echo "ghcr.io/sakompella/cf-stumble-workspace:$(sha256sum computerd.Dockerfile computerd-walk.patch | sha256sum | cut -c1-16)"
