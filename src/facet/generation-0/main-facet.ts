import { DurableObject } from "cloudflare:workers";
import { startFacetTurn } from "./facet-turn.js";
import { handleGeneration0Request } from "./request-handler.js";
import type { Generation0Capabilities } from "./capabilities.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

export class MainFacet extends DurableObject<Generation0Capabilities> {
  override fetch(request: Request): Promise<Response> {
    return handleGeneration0Request(request);
  }

  /**
   * The project capability is an argument because a Worker Loader entry is cached under the harness
   * commit and an `RpcTarget` cannot be serialized into a Loader environment. `workingDirectory` comes
   * from the host's catalog, so it arrives beside the untrusted request.
   */
  startTurn(
    projectTarget: ProjectRpcTargetContract,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted; `startFacetTurn` parses it.
    request: unknown,
    workingDirectory: string,
  ): ReadableStream<Uint8Array> {
    return startFacetTurn(this.env, projectTarget, request, workingDirectory);
  }
}
