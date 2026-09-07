# E1 — The Supervisor's build command cannot build a labeled commit from clean state

Status: CONFIRMED by the root agent, independent of the oracle. Blocker on the v0 critical path.
Sharpens architecture-critique finding 3 and roadmap task T1.

## The fault

`src/harness-build.ts:30` sets:

```ts
buildCommand: "pnpm run build:module-map",
```

`build:module-map` runs esbuild over `src/`, which imports `@cf-stumble/pi`.
That workspace package resolves through `vendor/pi-v0.84.4/package.json`:

```json
"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
```

`vendor/pi-v0.84.4/dist/` is NOT tracked: `git ls-files "vendor/**/dist"` returns 0 files.
It is produced by `pnpm build:pi` (`tsx build.mts`).

So a clean clone of a labeled harness commit has no `dist/index.js`, and the build fails:

```
ERROR: Could not resolve "@cf-stumble/pi"   (x5, all in src/facet/generation-0/)
The module "./dist/index.js" was not found on the file system
```

Reproduced twice: by the oracle in `/tmp/cf-stumble-v0/clean-harness-archive`
(log: `/tmp/cf-stumble-v0/clean-build-baseline.log`), and confirmed by direct
inspection of the package manifests and the git index.

## Why it is invisible locally

`package.json` `verify` is `pnpm build:pi && ... && pnpm build:module-map && pnpm test`.
`build:pi` runs FIRST, so a developer machine always has `dist/` populated before
anything reads it. The tracked pre-commit hook runs the same command. Every local
signal is green while the deployed build path is broken.

## Why it blocks v0

Goal criterion 7 requires two clean Computer builds of the same labeled commit to
produce identical canonical module maps, and a cold cache to load without rebuilding.
Criterion 8 requires the owner to build and activate a second harness commit. Both run
through `buildCommand`. Neither can pass today.

## Recommended fix (T1 scope)

Make the build command self-sufficient from a clean checkout: install, build the
vendored Pi package, then build the module map — ideally behind one `build:artifact`
script so the Supervisor's command and the local gate cannot drift apart again.
Do not check `dist/` into git; that trades a build fault for a staleness fault.

Then prove it: build the same labeled commit twice from clean state and compare the
canonical module maps byte for byte.
