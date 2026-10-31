import type { Wake } from "@earendil-works/pi-durable";
import type { ProjectRpcTargetContract } from "../workspace/project/protocol.js";

/**
 * What the Supervisor hands the serving facet (ADR-0048). Facets cannot set alarms, so the facet
 * relays its wake to `arm`. `workspace` answers a capability for the project whose conversation
 * asks, ended by the Supervisor when the run settles or is aborted.
 */
export interface ConversationHost {
  arm(wake: Wake): Promise<void>;
  /** The caller owns the capability it gets and disposes it when its use ends. */
  workspace(conversationId: string): Promise<ProjectRpcTargetContract & Disposable>;
}

/**
 * The RPC surface a Pi Durable generation's `MainFacet` adds to `fetch`. The Supervisor calls
 * `attach` before every other call; the facet keeps the first host and opens its session then.
 */
export interface ConversationFacet {
  piDurableVersion(): string;
  attach(host: ConversationHost): Promise<void>;
  createConversation(cwd: string): Promise<string>;
  submit(conversationId: string, content: string, requestId: string): Promise<number>;
  events(conversationId: string): Promise<ReadableStream<Uint8Array>>;
  abort(conversationId: string): Promise<void>;
}
