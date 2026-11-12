import * as Effect from "effect/Effect";
import type { MainFacetModel, MainFacetTarget, MainHarnessArtifact } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { ModuleMapStore } from "./store.js";
import type { StoredModuleMapProblem } from "./store.js";
import { buildModuleMap, type HarnessBuildProblem } from "./build.js";
import { SERVING_FACET_NAME, servingLoaderName } from "./facet-name.js";
import { mountFacet, type AttachableFacet } from "./old-protocol.js";
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
    oldProtocol?: Readonly<{ instance: number; model: MainFacetModel }>,
  ): Effect.Effect<AttachableFacet, MainFacetMountProblem> {
    return this.load(active).pipe(
      Effect.map((artifact) =>
        mountFacet(
          loader,
          facets,
          SERVING_FACET_NAME,
          artifact,
          oldProtocol === undefined
            ? undefined
            : {
                loaderName: servingLoaderName(artifact.harnessCommit, oldProtocol.instance),
                model: oldProtocol.model,
              },
        ),
      ),
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

export type { MainFacetModel } from "../../facet/index.js";

export {
  attachFacet,
  mountFacet,
  OLD_PROTOCOL_COMPATIBILITY,
  type AttachableFacet,
  type OldProtocolLoad,
} from "./old-protocol.js";

export { candidateFacetName, SERVING_FACET_NAME } from "./facet-name.js";

export { ModuleMapStore } from "./store.js";
