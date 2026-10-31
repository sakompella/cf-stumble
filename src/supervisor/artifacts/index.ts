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
import { SERVING_FACET_NAME } from "./facet-name.js";
import type { ActiveGeneration } from "../generations/index.js";

export type ModuleMapProblem =
  | MainHarnessArtifactProblem
  | StoredModuleMapProblem
  | HarnessBuildProblem;

export type MainFacetMountProblem = { readonly code: "no-active-generation" } | ModuleMapProblem;

export type MountedFacet = Fetcher<MainFacetTarget>;

export class HarnessArtifacts {
  private readonly store: ModuleMapStore;
  private readonly builder: HarnessModuleMapBuilder;

  constructor(storage: ModuleMapStorage, builder: HarnessModuleMapBuilder) {
    this.store = new ModuleMapStore(storage);
    this.builder = builder;
  }

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

  mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
    modelRoute: MainFacetCapabilities["MODEL"],
  ): Result.Result<MountedFacet, MainFacetMountProblem> {
    return this.load(active).pipe(
      Result.flatMap((artifact) =>
        loadMainFacet(loader, artifact, { MODEL: modelRoute }).pipe(
          Result.map((loadedFacet) =>
            facets.get<MainFacetTarget>(SERVING_FACET_NAME, () => ({
              class: loadedFacet.facetClass,
            })),
          ),
        ),
      ),
    );
  }

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

export type { MainFacetCapabilities, MainHarnessArtifactInput } from "../../facet/index.js";

export { candidateFacetName, SERVING_FACET_NAME } from "./facet-name.js";

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
