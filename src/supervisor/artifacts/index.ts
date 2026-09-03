import { Result } from "better-result";
import {
  fixtureMainHarnessArtifact,
  loadMainFacet,
  MainHarnessArtifact,
} from "../../facet/index.js";
import type { MainFacetCapabilities, MainHarnessArtifactInput } from "../../facet/index.js";
import { parseHarnessCommit } from "../../harness-commit.js";
import { ModuleMapCache } from "./cache.js";
import { canonicalModuleMap, sameModuleMap } from "./module-map.js";
import { resolveModuleMap } from "./resolver.js";
import type { HarnessModuleMapBuilder } from "./builder.js";
import { mainFacetName } from "./facet-name.js";
import type { ModuleMapProblem, ModuleMapResolution } from "./resolver.js";
import type { ActiveGeneration } from "../generations/index.js";

export type HarnessArtifactProblem =
  | ModuleMapProblem
  | { readonly code: "retained-artifact-mismatch"; readonly harnessCommit: string };

export type HarnessArtifactResult = Result<
  {
    readonly artifact: MainHarnessArtifactInput;
    readonly effect: "retained" | "verified" | "rebuilt";
  },
  HarnessArtifactProblem
>;

/**
 * The Supervisor's module-map access. R2 is an evictable cache and Durable Object SQLite stores no
 * module source, so every executable module map arrives through `resolve` or, for a map the caller
 * already holds, through `retain`.
 */
export class HarnessArtifacts {
  private readonly cache: ModuleMapCache;
  private readonly builder: HarnessModuleMapBuilder;

  constructor(bucket: R2Bucket, builder: HarnessModuleMapBuilder) {
    this.cache = new ModuleMapCache(bucket);
    this.builder = builder;
  }

  /** Build or read the module map for a labeled harness commit. See `resolveModuleMap`. */
  resolve(harnessCommit: string): Promise<ModuleMapResolution> {
    const validatedCommit = parseHarnessCommit(harnessCommit);
    if (validatedCommit === undefined) {
      return Promise.resolve(Result.err({ code: "invalid-harness-commit", harnessCommit }));
    }

    return resolveModuleMap(this.cache, this.builder, validatedCommit);
  }

  /**
   * Cache a module map the caller already holds. A commit that is already cached must describe the
   * same code, so a mismatch is reported rather than overwritten; a corrupt object is replaced.
   */
  async retain(input: MainHarnessArtifactInput): Promise<HarnessArtifactResult> {
    const parsed = MainHarnessArtifact.parse(input);
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }

    const canonical = canonicalModuleMap(parsed.value);
    const cached = await this.cache.read(parsed.value.harnessCommit);
    if (cached.isErr()) {
      if (cached.error.code !== "corrupt-artifact") {
        return Result.err(cached.error);
      }

      return this.write(canonical, "rebuilt");
    }

    if (cached.value.kind === "hit") {
      return sameModuleMap(cached.value.moduleMap, canonical)
        ? Result.ok({ artifact: cached.value.moduleMap, effect: "verified" })
        : Result.err({
            code: "retained-artifact-mismatch",
            harnessCommit: parsed.value.harnessCommit,
          });
    }

    return this.write(canonical, "retained");
  }

  async mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
    modelRoute: MainFacetCapabilities["MODEL"],
  ): Promise<Result<{ readonly fetcher: Fetcher }, string>> {
    const moduleMap = await this.activeModuleMap(active);
    if (moduleMap.isErr()) {
      return Result.err(moduleMap.error);
    }

    const artifact = moduleMap.value;
    const loadedFacet = loadMainFacet(loader, artifact, { MODEL: modelRoute });
    if (loadedFacet.isErr()) {
      return Result.err(loadedFacet.error.code);
    }

    return Result.ok({
      fetcher: facets.get(mainFacetName(artifact.harnessCommit, "serving"), () => ({
        class: loadedFacet.value.facetClass,
      })),
    });
  }

  /**
   * No active generation still serves the fixture seed. Real Generation 0 materialization replaces
   * it; `docs/agents/design/feature-map.md` ties that cleanup to the Generation 0 facet.
   */
  private async activeModuleMap(
    active: ActiveGeneration,
  ): Promise<Result<MainHarnessArtifactInput, string>> {
    if (active.generation === undefined) {
      const retained = await this.retain(fixtureMainHarnessArtifact);
      return retained.isErr()
        ? Result.err(retained.error.code)
        : Result.ok(retained.value.artifact);
    }

    const resolved = await this.resolve(active.generation.harnessCommit);
    return resolved.isErr() ? Result.err(resolved.error.code) : Result.ok(resolved.value.moduleMap);
  }

  private async write(
    moduleMap: MainHarnessArtifactInput,
    effect: "retained" | "rebuilt",
  ): Promise<HarnessArtifactResult> {
    const written = await this.cache.write(moduleMap);
    return written.isErr()
      ? Result.err(written.error)
      : Result.ok({ artifact: written.value, effect });
  }
}

export { mainFacetName } from "./facet-name.js";
export { ModuleMapCache } from "./cache.js";
export type { CachedModuleMap, StoredModuleMapProblem } from "./cache.js";
export {
  absentModuleMapBuilder,
  WorkspaceModuleMapBuilder,
  type BuildWorkspace,
  type HarnessBuildResult,
  type HarnessModuleMapBuilder,
} from "./builder.js";
export {
  moduleMapFromBuildOutput,
  planHarnessBuild,
  type BuiltModuleMapFile,
  type HarnessBuildConfiguration,
  type HarnessBuildPlan,
  type HarnessBuildProblem,
  type HarnessBuildStepName,
} from "./build-plan.js";
export { canonicalModuleMap, encodeModuleMap, sameModuleMap } from "./module-map.js";
export { resolveModuleMap } from "./resolver.js";
export type { ModuleMapProblem, ModuleMapResolution, ResolvedModuleMap } from "./resolver.js";
