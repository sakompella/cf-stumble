#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."
sha256sum .dockerignore containers/computerd.Dockerfile containers/computerd-walk.patch | sha256sum | cut -c1-16
