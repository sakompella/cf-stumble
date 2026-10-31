import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { loadMainFacet } from "../../facet/index.js";
import type {
  MainFacetCapabilities,
  MainFacetTarget,
  MainHarnessArtifact,
} from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { runAtEntryPoint } from "../../run-entry-point.js";
import { ModuleMapStore } from "./store.js";
import type { ModuleMapStorage, StoredModuleMapProblem } from "./store.js";
import { buildModuleMap, type BuildWorkspaceHost, type HarnessBuildProblem } from "./build.js";
import { SERVING_FACET_NAME } from "./facet-name.js";
import type { ActiveGeneration } from "../generations.js";

export type ModuleMapProblem = StoredModuleMapProblem | HarnessBuildProblem;

export type MainFacetMountProblem = { readonly code: "no-active-generation" } | ModuleMapProblem;

export type MountedFacet = Fetcher<MainFacetTarget>;

type SettledBuild = Result.Result<MainHarnessArtifact, HarnessBuildProblem>;

export class HarnessArtifacts {
  private readonly store: ModuleMapStore;
  private readonly workspace: () => BuildWorkspaceHost;
  private readonly inFlight = new Map<HarnessCommit, Promise<SettledBuild>>();

  constructor(storage: ModuleMapStorage, workspace: () => BuildWorkspaceHost) {
    this.store = new ModuleMapStore(storage);
    this.workspace = workspace;
  }

  prepare(harnessCommit: HarnessCommit): Effect.Effect<MainHarnessArtifact, ModuleMapProblem> {
    return Effect.gen({ self: this }, function* () {
      const stored = yield* Effect.fromResult(this.store.read(harnessCommit));

      if (stored.kind === "stored") {
        return stored.artifact;
      }

      const built = yield* this.build(harnessCommit);

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

  private build(
    harnessCommit: HarnessCommit,
  ): Effect.Effect<MainHarnessArtifact, HarnessBuildProblem> {
    return Effect.suspend(() => {
      const settled = this.inFlight.get(harnessCommit) ?? this.start(harnessCommit);

      return Effect.promise(() => settled).pipe(Effect.flatMap(Effect.fromResult));
    });
  }

  private start(harnessCommit: HarnessCommit): Promise<SettledBuild> {
    const started = runAtEntryPoint(
      Effect.result(buildModuleMap(this.workspace, harnessCommit)),
    ).finally(() => {
      this.inFlight.delete(harnessCommit);
    });

    this.inFlight.set(harnessCommit, started);

    return started;
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

export { MODULE_MAP_CHUNK_BYTES, ModuleMapStore } from "./store.js";

export type { ModuleMapStorage } from "./store.js";

export {
  buildModuleMap,
  type BuildWorkspaceHost,
  type BuildWorkspaceNamespace,
  type HarnessBuildProblem,
} from "./build.js";

export { encodeModuleMap } from "./module-map.js";
