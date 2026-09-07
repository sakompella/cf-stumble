# Slice 2 bundle probe

Question: does the Pi import closure this plan depends on bundle for workerd, how big is it, and
does anything drag in `node:`? Answered before vendoring anything into the repo, so a bad answer
would have cost an afternoon instead of a 4,000-line revert.

Probe lives at `/tmp/pi-bundle-probe`. The pristine clone was not modified; the Pi packages were
copied next to the probe's `node_modules` so bare-import resolution works from the importing file.

## Entry closure

`packages/agent/src/agent.ts`, `harness/tools/{read,write,edit,bash}.ts`,
`packages/ai/src/api/openai-completions.ts`, `packages/ai/src/api/cloudflare-gateway-binding.ts`.

Built with `esbuild --bundle --format=esm --platform=neutral --conditions=workerd,worker,browser`,
aliasing `@earendil-works/pi-ai` and `@earendil-works/pi-telemetry` to their `src/index.ts` because
both packages' `exports` point at an unbuilt `./dist`.

## Results

| Measure | Value |
| --- | --- |
| First-party Pi only, npm deps external | 171 KB |
| Full bundle, nothing external | 846 KB |
| Minified | 349 KB |
| Minified and gzipped | **98 KB** |
| Static `node:` import statements | **0** |

## The `node:` question

Two `node:` strings appear in the full bundle and neither is a static import.

- `pi-ai/src/utils/pi-user-agent.ts` calls `process.getBuiltinModule?.("node:os") ?? null`, guarded
  by a `typeof process === "undefined"` check, so it returns null in workerd.
- `pi-ai/src/utils/provider-env.ts` calls `__require("node:fs")` inside a try/catch to read
  `/proc/self/environ`. esbuild's `__require` shim throws "Dynamic require is not supported", the
  catch swallows it, and the result is an empty provider-env map. That is the correct outcome here:
  the model key never lives in the generation, it comes from the gateway binding.

## Consequences for the plan

- The vendoring approach is viable and the bundle is far inside Worker limits.
- The npm closure is narrower than section 4.1 assumed. It needs `openai`, `typebox`, `diff` and
  `partial-json`. It does not need `ignore` or `yaml`.
- Provider decision: root the `pi-ai` closure at `api/openai-completions.ts`. Workers AI exposes an
  OpenAI-compatible endpoint with a free daily allocation the owner is not otherwise using, so
  probes cost nothing, and the same closure swaps to a paid provider later without re-vendoring.

## What this does not prove

That the bundle *runs* in workerd. esbuild resolving imports is not workerd executing them. The
first real check is slice 2's test that imports the built package and constructs an `Agent`, and
after that slice 1's paid probe loading it through the Worker Loader.
