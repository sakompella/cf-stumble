import { Result } from "better-result";
import { loadMainFacet, MainHarnessArtifact } from "../../facet/index.js";
import type {
  MainFacetCapabilities,
  MainFacetTarget,
  MainHarnessArtifactInput,
  MainHarnessArtifactProblem,
} from "../../facet/index.js";
import { parseHarnessCommit, type HarnessCommit } from "../../harness-commit.js";
import { ModuleMapStore } from "./store.js";
import type { ModuleMapStorage, StoredModuleMapProblem } from "./store.js";
import { WorkspaceHostModuleMapBuilder, type BuildWorkspaceNamespace } from "./build-workspace.js";
import type { HarnessBuildProblem } from "./build-plan.js";
import type { HarnessModuleMapBuilder } from "./builder.js";
import { mainFacetName } from "./facet-name.js";
import type { ActiveGeneration } from "../generations/index.js";

export type ModuleMapProblem =
  | MainHarnessArtifactProblem
  | StoredModuleMapProblem
  | HarnessBuildProblem;

export type ModuleMapResult = Result<MainHarnessArtifactInput, ModuleMapProblem>;

/**
 * Why the main facet could not be mounted. `no-active-generation` is not a fault: no generation is
 * labeled active, so there is no code to serve. Every other problem describes the active
 * generation's stored module map, and none of them fall back to other code or to a build.
 */
export type MainFacetMountProblem = { readonly code: "no-active-generation" } | ModuleMapProblem;

/**
 * The Supervisor's module maps. There are two ways in and they are deliberately unequal.
 * `prepare` runs at submission and may build a commit that has nothing stored. `retain` stores a
 * map the caller already holds. Serving reads what is stored and never builds, so activating or
 * rolling back to a generation that is ready cannot depend on Computer being reachable.
 */
export class HarnessArtifacts {
  private readonly store: ModuleMapStore;
  private readonly builder: HarnessModuleMapBuilder;

  constructor(storage: ModuleMapStorage, builder: HarnessModuleMapBuilder) {
    this.store = new ModuleMapStore(storage);
    this.builder = builder;
  }

  /**
   * The artifacts of a tenant that builds in its own workspace. A commit with nothing stored is
   * built there, in the scratch subtree that holds no repository, so a build neither reads nor
   * replaces a checkout, and one build per commit runs at a time.
   */
  static forWorkspace(
    storage: ModuleMapStorage,
    namespace: BuildWorkspaceNamespace,
    workspaceName: string,
  ): HarnessArtifacts {
    return new HarnessArtifacts(
      storage,
      new WorkspaceHostModuleMapBuilder(namespace, workspaceName),
    );
  }

  /**
   * The module map of a labeled commit at submission time: the stored map when there is one, or a
   * build of that commit, validated and stored before this returns. A store that cannot be written
   * fails preparation, because a generation that becomes ready must have its code stored; nothing
   * later is allowed to rebuild it.
   */
  async prepare(harnessCommit: string): Promise<ModuleMapResult> {
    const validatedCommit = parseHarnessCommit(harnessCommit);

    if (validatedCommit === undefined) {
      return Result.err({ code: "invalid-harness-commit", harnessCommit });
    }

    const stored = this.store.read(validatedCommit);

    if (stored.isErr()) {
      return Result.err(stored.error);
    }

    if (stored.value.kind === "stored") {
      return Result.ok(stored.value.moduleMap);
    }

    const built = await this.builder.build(validatedCommit);

    if (built.isErr()) {
      return Result.err(built.error);
    }

    const validated = validatedBuild(validatedCommit, built.value);

    return validated.isErr() ? Result.err(validated.error) : this.store.write(validated.value);
  }

  /** Store a module map the caller already holds, replacing whatever that commit had stored. */
  retain(input: MainHarnessArtifactInput): ModuleMapResult {
    const parsed = MainHarnessArtifact.parse(input);

    return parsed.isErr() ? Result.err(parsed.error) : this.store.write(parsed.value);
  }

  /**
   * Mount the generation that serves. This waits for nothing: the module map is already in the
   * Durable Object's own SQLite, and reading it is synchronous.
   */
  mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
    modelRoute: MainFacetCapabilities["MODEL"],
  ): Result<{ readonly fetcher: Fetcher<MainFacetTarget> }, MainFacetMountProblem> {
    const moduleMap = this.load(active);

    if (moduleMap.isErr()) {
      return Result.err(moduleMap.error);
    }

    const artifact = moduleMap.value;
    const loadedFacet = loadMainFacet(loader, artifact, { MODEL: modelRoute });

    if (loadedFacet.isErr()) {
      return Result.err(loadedFacet.error);
    }

    return Result.ok({
      fetcher: facets.get<MainFacetTarget>(
        mainFacetName(artifact.harnessCommit, "serving"),
        () => ({
          class: loadedFacet.value.facetClass,
        }),
      ),
    });
  }

  /**
   * The module map of the generation that serves, read and nothing else. There is no built-in
   * alternative and no build: a Supervisor with no active generation reports
   * `no-active-generation`, and an active generation whose map is not stored reports that rather
   * than rebuilding it. A generation only becomes ready once `prepare` or `retain` stored its map,
   * so activation and rollback both load bytes that are already there.
   */
  private load(active: ActiveGeneration): Result<MainHarnessArtifactInput, MainFacetMountProblem> {
    if (active.generation === undefined) {
      return Result.err({ code: "no-active-generation" });
    }

    const harnessCommit = parseHarnessCommit(active.generation.harnessCommit);

    if (harnessCommit === undefined) {
      return Result.err({
        code: "invalid-harness-commit",
        harnessCommit: active.generation.harnessCommit,
      });
    }

    const stored = this.store.read(harnessCommit);

    if (stored.isErr()) {
      return Result.err(stored.error);
    }

    return stored.value.kind === "stored"
      ? Result.ok(stored.value.moduleMap)
      : Result.err({ code: "stored-module-map-absent", harnessCommit });
  }
}

/**
 * Validate and identify every build before it is stored or loaded. A build cannot deliver an
 * unloadable map, and it cannot deliver a map for another commit.
 */
function validatedBuild(
  harnessCommit: HarnessCommit,
  built: MainHarnessArtifactInput,
): Result<MainHarnessArtifact, ModuleMapProblem> {
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

  return Result.ok(parsed.value);
}

/**
 * `retain`, `mount`, and this group's builders all take these two as arguments, so every caller of
 * the group needs their types. Re-exporting them here means a caller does not reach into
 * `facet/index.js` for the parameter types of a method it is calling here.
 */
export type { MainFacetCapabilities, MainHarnessArtifactInput } from "../../facet/index.js";

export { mainFacetName } from "./facet-name.js";

export { MODULE_MAP_CHUNK_BYTES, ModuleMapStore } from "./store.js";

export type { ModuleMapStorage, StoredModuleMap, StoredModuleMapProblem } from "./store.js";

export {
  absentModuleMapBuilder,
  WorkspaceModuleMapBuilder,
  type BuildWorkspace,
  type HarnessBuildResult,
  type HarnessModuleMapBuilder,
} from "./builder.js";

export {
  CommitBuildWorkspace,
  WorkspaceHostModuleMapBuilder,
  type BuildWorkspaceHost,
  type BuildWorkspaceNamespace,
} from "./build-workspace.js";

export {
  HARNESS_BUILD_CONFIGURATION,
  moduleMapFromBuildOutput,
  planHarnessBuild,
  type BuiltModuleMapFile,
  type HarnessBuildConfiguration,
  type HarnessBuildPlan,
  type HarnessBuildProblem,
  type HarnessBuildStepName,
} from "./build-plan.js";

export { canonicalModuleMap, encodeModuleMap } from "./module-map.js";
