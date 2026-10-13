import { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { chatgptTurn, type ChatGPTAccess, type ChatGPTCredential } from "./chatgpt/index.js";
import { parseRequest, type ValidationFailure } from "./model-route-request.js";
import { streamingBindingCall, workersAiTurn } from "./model-route-stream.js";
import { modelEventStream, type ModelTurn } from "./model-route-turn.js";

export { parseRequest } from "./model-route-request.js";

export { streamModelEvents } from "./model-route-stream.js";

export type {
  UserMessage,
  ToolCall,
  AssistantMessage,
  ToolResultMessage,
  RouteMessage,
  ToolDefinition,
  ModelRouteRequest,
  ValidationFailure,
} from "./model-route-request.js";

export type {
  ModelRouteErrorCode,
  ModelStreamEvent,
  ModelStreamInference,
  ModelUsage,
  StreamingProviderPayload,
  ToolCallDelta,
} from "./model-route-events.js";

// -- Service binding entrypoint ---------------------------------------------

/** The Supervisor methods this route uses, on the Supervisor that holds the owner's credential. */
type CredentialHolders = Readonly<{
  getByName(name: string): Readonly<{
    chatgptAccess(rejected?: string): Promise<ChatGPTAccess>;
    markChatGPTRefused(accessToken: string): Promise<void>;
  }>;
}>;

type ModelRouteEnv = Readonly<{
  AI: Ai;
  SUPERVISOR: CredentialHolders;
  /** The ChatGPT model, a declared plain variable (`cloudflare.config.ts`). */
  CHATGPT_MODEL: string;
}>;

/**
 * Set by the Supervisor that hands this route to its facets, and invisible to them: the facet holds
 * a stub, not these props. A route no Supervisor created has no credential to consult and answers
 * from Workers AI.
 */
export type ModelRouteProps = Readonly<{ supervisor: string }> | undefined;

export class ModelRoute extends WorkerEntrypoint<ModelRouteEnv, ModelRouteProps> {
  /** Answers with incremental model events. Every failure after validation becomes an event on the
   * returned stream, which is what lets this cross the RPC boundary as a plain byte stream
   * (ADR-0045), like `MainFacetTarget.startTurn`.
   *
   * The owner's ChatGPT plan answers while a credential is connected; Workers AI answers while none
   * is. A refused or revoked grant fails the call with `chatgpt-reconnect-required` rather than
   * switching provider (ADR-0047). */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: service-binding input is untrusted.
  runStream(request: unknown): ReadableStream<Uint8Array> | ValidationFailure {
    const parsed = parseRequest(request);

    if (Result.isFailure(parsed)) return parsed.failure;
    const validated = parsed.success;

    const workersAi = workersAiTurn(
      { run: (model, input) => streamingBindingCall(this.env.AI, model, input) },
      validated,
    );

    const credential = this.chatgptCredential();

    if (credential === undefined) return modelEventStream(workersAi);

    const chatgpt = chatgptTurn(
      {
        credential,
        fetcher: (url, init) => fetch(url, init),
        model: this.env.CHATGPT_MODEL,
      },
      validated,
    );

    const turn: ModelTurn = (emit) =>
      chatgpt(emit).pipe(Effect.catchTag("ChatGPTNotConnected", () => workersAi(emit)));

    return modelEventStream(turn);
  }

  private chatgptCredential(): ChatGPTCredential | undefined {
    const name = this.ctx.props?.supervisor;

    if (name === undefined) return undefined;
    const holder = this.env.SUPERVISOR.getByName(name);

    return {
      access: (rejected) => holder.chatgptAccess(rejected),
      markRefused: (accessToken) => holder.markChatGPTRefused(accessToken),
    };
  }
}
