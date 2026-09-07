#!/usr/bin/env bash
# Re-runs every load-bearing citation in _main-harness-implementation-plan.md.
set -uo pipefail

PI=/tmp/cf-stumble-pi-v0.84.4
CO=/tmp/computer-src
REPO="$(cd "$(dirname "$0")/.." && pwd)"
pass=0
fail=0

check() {
  if eval "$2" >/dev/null 2>&1; then
    printf 'ok    %s\n' "$1"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n' "$1"; fail=$((fail + 1))
  fi
}

check "pi clone at pinned commit" \
  "[ \"\$(git -C $PI rev-parse HEAD)\" = b79e4cc834970cca69daebffab7df1da7d1e52c4 ]"
check "pi ExecutionEnv extends FileSystem, Shell" \
  "rg -q 'interface ExecutionEnv extends FileSystem, Shell' $PI/packages/agent/src/harness/types.ts"
check "pi FileSystem documented as never throwing" \
  "rg -q 'must never throw or reject' $PI/packages/agent/src/harness/types.ts"
check "pi Agent class exists" \
  "rg -q '^export class Agent' $PI/packages/agent/src/agent.ts"
check "AgentHarness rejects with HarnessNotImplemented" \
  "rg -q 'HarnessNotImplemented' $PI/packages/agent/src/harness/agent-harness.ts"
check "createGatewayBindingFetch exists" \
  "rg -q '^export function createGatewayBindingFetch' $PI/packages/ai/src/api/cloudflare-gateway-binding.ts"
check "node: imports confined to two files in packages/agent/src" \
  "[ \"\$(rg -l '^import .*node:' $PI/packages/agent/src | wc -l | tr -d ' ')\" = 2 ]"
check "node: import file 1 is harness/env/nodejs.ts" \
  "rg -l '^import .*node:' $PI/packages/agent/src | rg -q 'harness/env/nodejs.ts'"
check "node: import file 2 is session/testing/conformance.ts" \
  "rg -l '^import .*node:' $PI/packages/agent/src | rg -q 'session/testing/conformance.ts'"
check "coding-agent tools depend on pi-tui" \
  "rg -q 'pi-tui' $PI/packages/coding-agent/src/core/tools/read.ts"

check "computer clone at ADR-0026 commit" \
  "[ \"\$(git -C $CO rev-parse HEAD)\" = 12336475c9fd03f5280a4537a707797fc0131fbd ]"
check "container backend requires ctx.container" \
  "rg -q 'if \(!ctx.container\)' $CO/packages/computer/src/backends/container/container-host.ts"
check "container example declares containers[].class_name" \
  "rg -q '\"class_name\": \"ContainerExample\"' $CO/examples/container/wrangler.jsonc"
check "proxy.ts: DO namespace refs are not clonable" \
  "rg -q \"DurableObjectNamespace references aren't clonable\" $CO/packages/computer/src/proxy.ts"
check "proxy.ts: ctx.exports loopback binding is the supported route" \
  "rg -q 'ctx.exports' $CO/packages/computer/src/proxy.ts"
check "computer store has no native rename" \
  "rg -q \"store doesn't have a native rename\" $CO/packages/computer/src/backends/worker-shell/adapter.ts"
check "npm has no @cloudflare/computer 0.3.0" \
  "! npm view @cloudflare/computer versions 2>/dev/null | rg -q \"'0.3.0'\""
check "@cloudflare/dofs unpublished" \
  "! npm view @cloudflare/dofs version >/dev/null 2>&1"
check "@cloudflare/computer-rpc unpublished" \
  "! npm view @cloudflare/computer-rpc version >/dev/null 2>&1"

check "relay bodyOutcome credits absent content-length" \
  "rg -q 'expectedBytes === undefined \|\| expectedBytes === bodyBytes' $REPO/src/supervisor/relay/index.ts"
check "artifacts still retained in supervisor SQLite" \
  "rg -q 'harness_artifact_modules' $REPO/src/supervisor/artifacts/index.ts"
check "ADR-0034 requires Computer rebuild on cache miss" \
  "rg -q 'cache miss asks Computer to rebuild' $REPO/docs/agents/adr/0034-cache-rebuildable-module-maps-in-r2.md"
check "ADR-0027 forbids a second artifact identity" \
  "rg -q 'digest, mount key, or second artifact identity' $REPO/docs/agents/adr/0034-cache-rebuildable-module-maps-in-r2.md"
check "ADR-0026 pins source and image as a pair" \
  "rg -q '12336475c9fd03f5280a4537a707797fc0131fbd' $REPO/docs/agents/adr/0026-adopt-computer-for-facet-work-environment.md"
check "module-seams test keys on index.ts" \
  "rg -q 'index.ts' $REPO/test/docs/module-seams.test.ts"
check "oxlint ignorePatterns exists to extend" \
  "rg -q 'ignorePatterns' $REPO/oxlint.config.ts"
check "fixture is the current harness" \
  "[ -f $REPO/src/facet/fixture.ts ]"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
