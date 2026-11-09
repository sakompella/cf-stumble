import * as Effect from "effect/Effect";
import { loadMainFacet } from "../../facet/index.js";
import type {
  MainFacetCapabilities,
  MainFacetTarget,
  MainHarnessArtifact,
} from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { ModuleMapStore } from "./store.js";
import type { StoredModuleMapProblem } from "./store.js";
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

  constructor(bucket: R2Bucket, workspace: () => WorkspaceHostRpc<"build">) {
    this.store = new ModuleMapStore(bucket);
    this.workspace = workspace;
  }

  prepare(harnessCommit: HarnessCommit): Effect.Effect<MainHarnessArtifact, ModuleMapProblem> {
    return Effect.gen({ self: this }, function* () {
      const stored = yield* Effect.promise(() => this.store.read(harnessCommit)).pipe(
        Effect.flatMap(Effect.fromResult),
      );

      if (stored.kind === "stored") {
        return stored.artifact;
      }

      const built = yield* buildModuleMap(this.workspace, harnessCommit);

      const written = yield* Effect.promise(() => this.store.write(built));

      return yield* Effect.fromResult(written);
    });
  }

  mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
    modelRoute: MainFacetCapabilities["MODEL"],
  ): Effect.Effect<MountedFacet, MainFacetMountProblem> {
    return this.load(active).pipe(
      Effect.map((artifact) => {
        const { facetClass } = loadMainFacet(loader, artifact, { MODEL: modelRoute });

        return facets.get<MainFacetTarget>(SERVING_FACET_NAME, () => ({ class: facetClass }));
      }),
    );
  }

  private load(
    active: ActiveGeneration,
  ): Effect.Effect<MainHarnessArtifact, MainFacetMountProblem> {
    if (active.generation === undefined) {
      return Effect.fail({ code: "no-active-generation" });
    }

    const { harnessCommit } = active.generation;

    return Effect.promise(() => this.store.read(harnessCommit)).pipe(
      Effect.flatMap(Effect.fromResult),
      Effect.flatMap((stored) =>
        stored.kind === "stored"
          ? Effect.succeed(stored.artifact)
          : Effect.fail({ code: "stored-module-map-absent", harnessCommit } as const),
      ),
    );
  }
}

export type { MainFacetCapabilities } from "../../facet/index.js";

export { candidateFacetName, SERVING_FACET_NAME } from "./facet-name.js";

export { migrateModuleMaps } from "./migrate.js";

export { ModuleMapStore } from "./store.js";
