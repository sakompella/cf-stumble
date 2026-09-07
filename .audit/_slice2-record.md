# Slice 2 record: vendor Pi

Commit `1d59610`, 262 files, `pnpm verify` green at 33 files / 168 tests. Upstream clone at
/tmp/cf-stumble-pi-v0.84.4 still pristine.

## What landed

`vendor/pi-v0.84.4/` holds `packages/{agent,ai,telemetry}` verbatim at tag v0.84.4, commit
`b79e4cc834970cca69daebffab7df1da7d1e52c4`, as the workspace package `@cf-stumble/pi`. It emits a
bundle plus generated declarations, so `tsc` never walks vendored sources. Gate order is now
`build:pi`, `verify:vendor`, `typecheck`, `format:check`, `lint`, `test`.

## Three defects found by testing, not by reading summaries

Each was reported as working before I checked it.

1. **The declaration façade misdescribed the agent seam.** The first attempt fell back to
   hand-written declarations and flattened `AgentEvent` to `{ type: string; [key: string]: unknown }`
   against upstream's 11-variant union, and declared a 4-argument tool `execute` where the real
   `AgentHarnessTool.execute` takes 5 including `context`. Both types are what slices 4 and 5 are
   built on. Fixed by generating real declarations with ambient stubs for the provider SDKs.
2. **A `node:os` resolution fired at runtime in workerd.** `pi-user-agent.ts` probes at module top
   level, and its `typeof process === "undefined" || !process.versions?.node` guard passes under
   workerd, so `getBuiltinModule("node:os")` triggers a resolution that fails. My bundle probe had
   called this safe, which was wrong: esbuild resolving statically is not workerd executing. Fixed
   with an esbuild `onResolve` redirect to a three-line shim outside the vendored tree.
3. **The conformance check was a tautology.** It emitted declarations twice from the same
   `index.ts` with the same tsconfig into different `outDir`s and asserted the two were equivalent.
   They always were. The agent's own verification had renamed a type inside `dist/index.d.ts`,
   which the build deletes and regenerates, so it proved nothing. Fixed by emitting the reference
   tree from a separately written `upstream-surface.ts`.

## Detectors, verified by breaking them

- Appending a comment to `packages/agent/src/agent.ts` produced
  `SHA256 mismatch for packages/agent/src/agent.ts` and a non-zero exit.
- Replacing the `AgentEvent` re-export in `index.ts` with `export type AgentEvent = { type: string }`
  produced `Declaration conformance check failed` and `declaration-conformance.ts(23,10): error
  TS2344: Type 'false' does not satisfy the constraint 'true'`, exit 1.
- Re-exporting `createReadTool` from a stub with a 4-argument `execute` failed the same way at
  `declaration-conformance.ts(41,10)`.

Both restored clean afterwards.

## Residual limitation, recorded deliberately

`index.ts` and `upstream-surface.ts` are currently byte-identical, so the conformance check verifies
that the **emit pipeline** (facades, SDK shims, import rewriting) does not corrupt the type
contract. It does not detect upstream shape changes on a re-pin, because both entries regenerate
from the new source together. That is acceptable: an upstream shape change that breaks us surfaces
as a strict typecheck failure in consumer code, and the corruption class this does catch is exactly
the one that already bit us once.

## Dead code removed

The superseded hand-written `declarations.d.ts` was still on disk and still blessed by
`SHA256SUMS` while no longer being generated. Deleted and hashes refreshed. A dead file that looks
like the type contract is worse than no file.

## Correction to the earlier probe record

`.audit/_slice2-bundle-probe.md` concluded the guarded `node:os` reference was safe in workerd.
That conclusion was wrong, per defect 2 above. The measurements in that file stand; the safety
conclusion does not.

## Next

Slice 3, R2 materialization, replacing the SQLite artifact retention that contradicts ADR-0034.
Local and free. Slice 1's paid probe stays blocked on an explicit go.
