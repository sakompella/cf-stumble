import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { loadMainFacet } from "../../facet/index.js";
import type {
  MainFacetCapabilities,
  MainFacetTarget,
  MainHarnessArtifact,
} from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { ModuleMapStore } from "./store.js";
import type { ModuleMapStorage, StoredModuleMapProblem } from "./store.js";
import { buildModuleMap, type HarnessBuildProblem } from "./build.js";
import { SERVING_FACET_NAME } from "./facet-name.js";
import type { ActiveGeneration } from "../generations.js";
import type { WorkspaceHostRpc } from "../../workspace/index.js";

export type ModuleMapProblem = StoredModuleMapProblem | HarnessBuildProblem;

export type MainFacetMountProblem = { readonly code: "no-active-generation" } | ModuleMapProblem;

export type MountedFacet = Fetcher<MainFacetTarget>;

export class HarnessArtifacts {
  private readonly store: ModuleMapStore;
  private readonly workspace: () => WorkspaceHostRpc<"build">;

  constructor(storage: ModuleMapStorage, workspace: () => WorkspaceHostRpc<"build">) {
    this.store = new ModuleMapStore(storage);
    this.workspace = workspace;
  }

  prepare(harnessCommit: HarnessCommit): Effect.Effect<MainHarnessArtifact, ModuleMapProblem> {
    return Effect.gen({ self: this }, function* () {
      const stored = yield* Effect.fromResult(this.store.read(harnessCommit));

      if (stored.kind === "stored") {
        return stored.artifact;
      }

      const built = yield* buildModuleMap(this.workspace, harnessCommit);

      return yield* Effect.fromResult(this.store.write(built));
    });
  }

  mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
    modelRoute: MainFacetCapabilities["MODEL"],
  ): Result.Result<MountedFacet, MainFacetMountProblem> {
    return this.load(active).pipe(
      Result.map((artifact) => {
        const { facetClass } = loadMainFacet(loader, artifact, { MODEL: modelRoute });

        return facets.get<MainFacetTarget>(SERVING_FACET_NAME, () => ({ class: facetClass }));
      }),
    );
  }

  private load(
    active: ActiveGeneration,
  ): Result.Result<MainHarnessArtifact, MainFacetMountProblem> {
    if (active.generation === undefined) {
      return Result.fail({ code: "no-active-generation" });
    }

    const { harnessCommit } = active.generation;

    return this.store
      .read(harnessCommit)
      .pipe(
        Result.flatMap((stored): Result.Result<MainHarnessArtifact, MainFacetMountProblem> =>
          stored.kind === "stored"
            ? Result.succeed(stored.artifact)
            : Result.fail({ code: "stored-module-map-absent", harnessCommit }),
        ),
      );
  }
}

export type { MainFacetCapabilities } from "../../facet/index.js";

export { candidateFacetName, SERVING_FACET_NAME } from "./facet-name.js";

export { ModuleMapStore } from "./store.js";

export type { ModuleMapStorage } from "./store.js";
