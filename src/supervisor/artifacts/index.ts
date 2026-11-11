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
import { SERVING_FACET_NAME, servingLoaderName } from "./facet-name.js";
import type { ActiveGeneration } from "../generations.js";
import type { WorkspaceHostRpc } from "../../workspace/index.js";

export type ModuleMapProblem = StoredModuleMapProblem | HarnessBuildProblem;

export type MainFacetMountProblem = { readonly code: "no-active-generation" } | ModuleMapProblem;

export type MountedFacet = Fetcher<MainFacetTarget>;

const DECODED_MAPS_KEPT = 2;

export class HarnessArtifacts {
  private readonly store: ModuleMapStore;
  private readonly workspace: () => WorkspaceHostRpc<"build">;
  private readonly decoded = new Map<HarnessCommit, MainHarnessArtifact>();

  constructor(bucket: R2Bucket, workspace: () => WorkspaceHostRpc<"build">) {
    this.store = new ModuleMapStore(bucket);
    this.workspace = workspace;
  }

  prepare(harnessCommit: HarnessCommit): Effect.Effect<MainHarnessArtifact, ModuleMapProblem> {
    return Effect.gen({ self: this }, function* () {
      const stored = yield* this.read(harnessCommit);

      if (stored !== undefined) {
        return stored;
      }

      const built = yield* buildModuleMap(this.workspace, harnessCommit);

      const written = yield* Effect.promise(() => this.store.write(built)).pipe(
        Effect.flatMap(Effect.fromResult),
      );

      return this.remembered(written);
    });
  }

  mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
    modelRoute: (instance: number) => MainFacetCapabilities["MODEL"],
    instance: number,
  ): Effect.Effect<MountedFacet, MainFacetMountProblem> {
    return this.load(active).pipe(
      Effect.map((artifact) => {
        const { facetClass } = loadMainFacet(
          loader,
          artifact,
          { MODEL: modelRoute(instance) },
          servingLoaderName(artifact.harnessCommit, instance),
        );

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
    const cached = this.decoded.get(harnessCommit);

    if (cached !== undefined) return Effect.succeed(this.remembered(cached));

    return this.read(harnessCommit).pipe(
      Effect.flatMap((artifact) =>
        artifact === undefined
          ? Effect.fail({ code: "stored-module-map-absent", harnessCommit } as const)
          : Effect.succeed(artifact),
      ),
    );
  }

  private read(
    harnessCommit: HarnessCommit,
  ): Effect.Effect<MainHarnessArtifact | undefined, StoredModuleMapProblem> {
    return Effect.promise(() => this.store.read(harnessCommit)).pipe(
      Effect.flatMap(Effect.fromResult),
      Effect.map((stored) =>
        stored.kind === "stored" ? this.remembered(stored.artifact) : undefined,
      ),
    );
  }

  private remembered(artifact: MainHarnessArtifact): MainHarnessArtifact {
    this.decoded.delete(artifact.harnessCommit);
    this.decoded.set(artifact.harnessCommit, artifact);

    for (const leastRecent of this.decoded.keys()) {
      if (this.decoded.size <= DECODED_MAPS_KEPT) break;
      this.decoded.delete(leastRecent);
    }

    return artifact;
  }
}

export type { MainFacetCapabilities } from "../../facet/index.js";

export { candidateFacetName, SERVING_FACET_NAME } from "./facet-name.js";

export { ModuleMapStore } from "./store.js";
