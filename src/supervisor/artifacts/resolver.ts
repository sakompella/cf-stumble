import { Result } from "better-result";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { ModuleMapCache, StoredModuleMapProblem } from "./cache.js";
import { canonicalModuleMap } from "./module-map.js";
import type { HarnessBuildProblem } from "./build-plan.js";
import type { HarnessModuleMapBuilder } from "./builder.js";

export type ModuleMapProblem =
  | MainHarnessArtifactProblem
  | StoredModuleMapProblem
  | HarnessBuildProblem;

/**
 * Where the module map about to be loaded came from. A build reports whether the cache write
 * succeeded, because a failed write costs the next request a rebuild but must not stop this one.
 */
export type ResolvedModuleMap =
  | Readonly<{ source: "cache"; moduleMap: MainHarnessArtifactInput }>
  | Readonly<{
      source: "build";
      moduleMap: MainHarnessArtifactInput;
      cacheWrite: "written" | "failed";
    }>;

export type ModuleMapResolution = Result<ResolvedModuleMap, ModuleMapProblem>;

/**
 * The one resolver ADR-0034 requires, used by startup checking and by normal serving. A cache hit
 * loads; a miss or a corrupt object rebuilds the labeled commit, validates it, and caches it under
 * that same commit. A cache read that fails outright is reported instead: an unavailable bucket
 * says nothing about the commit, and rebuilding would spend a build on every request until R2
 * recovers.
 */
export async function resolveModuleMap(
  cache: ModuleMapCache,
  builder: HarnessModuleMapBuilder,
  harnessCommit: HarnessCommit,
): Promise<ModuleMapResolution> {
  const cached = await cache.read(harnessCommit);
  if (cached.isErr() && cached.error.code !== "corrupt-artifact") {
    return Result.err(cached.error);
  }

  if (cached.isOk() && cached.value.kind === "hit") {
    return Result.ok({ source: "cache", moduleMap: cached.value.moduleMap });
  }

  const built = await builder.build(harnessCommit);
  if (built.isErr()) {
    return Result.err(built.error);
  }

  const validated = validatedBuild(harnessCommit, built.value);
  if (validated.isErr()) {
    return Result.err(validated.error);
  }

  const written = await cache.write(validated.value);
  return Result.ok({
    source: "build",
    moduleMap: validated.value,
    cacheWrite: written.isErr() ? "failed" : "written",
  });
}

/**
 * The resolver validates and canonicalizes every build before it caches or loads one. A build
 * cannot deliver an unloadable map, and it cannot deliver a map for another commit.
 */
function validatedBuild(
  harnessCommit: HarnessCommit,
  built: MainHarnessArtifactInput,
): Result<MainHarnessArtifactInput, ModuleMapProblem> {
  const parsed = MainHarnessArtifact.parse(built);
  if (parsed.isErr()) {
    return Result.err({
      code: "build-output-invalid",
      harnessCommit,
      reason: parsed.error.code,
    });
  }

  if (parsed.value.harnessCommit !== harnessCommit) {
    return Result.err({
      code: "build-output-invalid",
      harnessCommit,
      reason: "invalid-harness-commit",
    });
  }

  return Result.ok(canonicalModuleMap(parsed.value));
}
