#!/usr/bin/env bash
# Run the Worker locally.
set -euo pipefail

# `cf dev` is not used here: observed with Wrangler 4.145, it fails on the Durable Object binding
# that `cloudflare.config.ts` writes for the Worker itself ("defined on another Worker") once a
# Container is attached to that Durable Object. `wrangler.jsonc` is kept equal to
# `cloudflare.config.ts` by test/docs/cloudflare-config-drift.test.ts.
exec pnpm exec wrangler dev "$@"
