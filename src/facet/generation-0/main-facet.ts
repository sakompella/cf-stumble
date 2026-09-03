/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { handleGeneration0Request } from "./request-handler.js";
import type { Generation0Capabilities } from "./capabilities.js";

/**
 * Generation 0 of the main harness. The Supervisor mounts this class as a Dynamic Worker facet
 * under the labeled harness commit and relays ordinary requests to it (ADR-0024, ADR-0027).
 *
 * Its environment holds capabilities only. The class keeps no durable state of its own: the
 * conversation arrives with each turn and is stored outside every generation.
 */
export class MainFacet extends DurableObject<Generation0Capabilities> {
  override fetch(request: Request): Promise<Response> {
    return handleGeneration0Request(request, this.env);
  }
}
