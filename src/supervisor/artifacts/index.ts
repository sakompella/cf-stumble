import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
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

/**
 * Why the main facet could not be mounted. `no-active-generation` is not a fault: no generation is
 * labeled active, so there is no code to serve. Every other problem describes the active
 * generation's stored module map, and none of them fall back to other code or to a build.
 */
export type MainFacetMountProblem = { readonly code: "no-active-generation" } | ModuleMapProblem;

/**
 * The Supervisor's module maps. The one way in is `prepare`, which runs at submission and may
 * build a commit that has nothing stored. Serving reads what is stored and never builds, so
 * activating or rolling back to a generation that is ready cannot depend on Computer being
 * reachable.
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
  prepare(harnessCommit: string): Effect.Effect<MainHarnessArtifactInput, ModuleMapProblem> {
    return Effect.gen({ self: this }, function* () {
      const validatedCommit = parseHarnessCommit(harnessCommit);

      if (validatedCommit === undefined) {
        return yield* Effect.fail<ModuleMapProblem>({
          code: "invalid-harness-commit",
          harnessCommit,
        });
      }

      const stored = yield* Effect.fromResult(this.store.read(validatedCommit));

      if (stored.kind === "stored") {
        return stored.moduleMap;
      }

      const built = yield* this.builder.build(validatedCommit);
      const artifact = yield* Effect.fromResult(validatedBuild(validatedCommit, built));

      return yield* Effect.fromResult(this.store.write(artifact));
    });
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
  ): Result.Result<{ readonly fetcher: Fetcher<MainFacetTarget> }, MainFacetMountProblem> {
    return this.load(active).pipe(
      Result.flatMap((artifact) =>
        loadMainFacet(loader, artifact, { MODEL: modelRoute }).pipe(
          Result.map((loadedFacet) => ({
            fetcher: facets.get<MainFacetTarget>(
              mainFacetName(artifact.harnessCommit, "serving"),
              () => ({ class: loadedFacet.facetClass }),
            ),
          })),
        ),
      ),
    );
  }

  /**
   * The module map of the generation that serves, read and nothing else. There is no built-in
   * alternative and no build: a Supervisor with no active generation reports
   * `no-active-generation`, and an active generation whose map is not stored reports that rather
   * than rebuilding it. A generation only becomes ready once `prepare` stored its map, so
   * activation and rollback both load bytes that are already there.
   */
  private load(
    active: ActiveGeneration,
  ): Result.Result<MainHarnessArtifactInput, MainFacetMountProblem> {
    if (active.generation === undefined) {
      return Result.fail({ code: "no-active-generation" });
    }

    const harnessCommit = parseHarnessCommit(active.generation.harnessCommit);

    if (harnessCommit === undefined) {
      return Result.fail({
        code: "invalid-harness-commit",
        harnessCommit: active.generation.harnessCommit,
      });
    }

    return this.store
      .read(harnessCommit)
      .pipe(
        Result.flatMap((stored): Result.Result<MainHarnessArtifactInput, MainFacetMountProblem> =>
          stored.kind === "stored"
            ? Result.succeed(stored.moduleMap)
            : Result.fail({ code: "stored-module-map-absent", harnessCommit }),
        ),
      );
  }
}

/**
 * Validate and identify every build before it is stored or loaded. A build cannot deliver an
 * unloadable map, and it cannot deliver a map for another commit.
 */
function validatedBuild(
  harnessCommit: HarnessCommit,
  built: MainHarnessArtifactInput,
): Result.Result<MainHarnessArtifact, ModuleMapProblem> {
  const parsed = MainHarnessArtifact.parse(built);

  if (Result.isFailure(parsed)) {
    return Result.fail({
      code: "build-output-invalid",
      harnessCommit,
      reason: parsed.failure.code,
    });
  }

  if (parsed.success.harnessCommit !== harnessCommit) {
    return Result.fail({
      code: "build-output-invalid",
      harnessCommit,
      reason: "invalid-harness-commit",
    });
  }

  return parsed;
}

/**
 * `mount` and this group's builders take these two as arguments, so every caller of the group
 * needs their types. Re-exporting them here means a caller does not reach into `facet/index.js`
 * for the parameter types of a method it is calling here.
 */
export type { MainFacetCapabilities, MainHarnessArtifactInput } from "../../facet/index.js";

export { mainFacetName } from "./facet-name.js";

export { MODULE_MAP_CHUNK_BYTES, ModuleMapStore } from "./store.js";

export type { ModuleMapStorage } from "./store.js";

export {
  WorkspaceModuleMapBuilder,
  type BuildWorkspace,
  type HarnessBuild,
  type HarnessModuleMapBuilder,
} from "./builder.js";

export {
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
} from "./build-plan.js";

export { canonicalModuleMap, encodeModuleMap } from "./module-map.js";
