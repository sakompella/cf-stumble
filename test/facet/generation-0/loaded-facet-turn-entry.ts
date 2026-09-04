/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from "cloudflare:workers";
import { startFacetTurn } from "../../../src/facet/generation-0/facet-turn.js";
import type { ModelCapability } from "../../../src/facet/generation-0/index.js";
import type { ModelRouteRequest, ModelRouteResponse } from "../../../src/model-route.js";
import type { ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";

/**
 * The loader environment of a facet that runs turns. It holds one plain, structured-clone value:
 * the scripted answers this fixture's model route hands back. Nothing project-scoped can be here,
 * and not by convention — `test/facet/loader-environment.test.ts` shows the Worker Loader refuses
 * to serialize an `RpcTarget` into an environment at all.
 */
interface LoadedFacetTurnEnv {
  readonly MODEL_SCRIPT: string;
}

const NOTHING_MORE: ModelRouteResponse = {
  ok: true,
  message: { role: "assistant", content: "", tool_calls: [] },
};

/** A model route built from the plain script in loader environment, not from a capability. */
function scriptedRoute(script: string): ModelCapability {
  // SAFETY: the test that loads this fixture writes MODEL_SCRIPT with JSON.stringify of exactly
  // this array, and nothing else can set a loaded worker's environment.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const answers = JSON.parse(script) as ModelRouteResponse[];
  return {
    run(_request: ModelRouteRequest): Promise<ModelRouteResponse> {
      return Promise.resolve(answers.shift() ?? NOTHING_MORE);
    },
  };
}

/**
 * Test-only Worker Loader entrypoint mirroring what `MainFacet` does, in the one way a test can
 * reach: `MainFacet` is a Durable Object class, and only a Durable Object's own `facets.get` can
 * instantiate one, so this entrypoint stands in for it and calls the same `startFacetTurn`.
 *
 * `startTurn` receives a live `ProjectRpcTargetContract` as an RPC method argument, which is the
 * only way Workers RPC can hand this isolate a capability that calls back into a target
 * constructed in the caller's isolate.
 */
export default class LoadedFacetTurnEntry extends WorkerEntrypoint<LoadedFacetTurnEnv> {
  /** Every name this isolate's environment holds, so a caller can see no capability is among them. */
  environmentKeys(): string[] {
    return Object.keys(this.env).toSorted();
  }

  startTurn(
    projectTarget: ProjectRpcTargetContract,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: mirrors `MainFacet.startTurn`, whose request arrives over RPC unproven.
    request: unknown,
  ): ReadableStream<Uint8Array> {
    return startFacetTurn({ MODEL: scriptedRoute(this.env.MODEL_SCRIPT) }, projectTarget, request);
  }

  /**
   * The same shape `startFacetTurn` has — return a stream now, use the capability later — but
   * holding the received stub instead of a duplicate of it. Reports one line saying what the
   * runtime did, so a test can show against the real runtime why the duplicate is not optional.
   */
  reachWithoutDuplicating(projectTarget: ProjectRpcTargetContract): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        let outcome: string;
        try {
          await projectTarget.lstat("/");
          outcome = "reached the workspace";
        } catch (error) {
          outcome = String(error);
        }
        controller.enqueue(new TextEncoder().encode(outcome));
        controller.close();
      },
    });
  }
}
