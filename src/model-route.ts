import { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { chatgptTurn, type ChatGPTAccess, type ChatGPTCredential } from "./chatgpt/index.js";
import { parseRequest, type RouteWire, type ValidationFailure } from "./model-route-request.js";
import { workersAiTurn } from "./model-route-stream.js";
import type { WorkersAiBinding } from "./model-route-events.js";
import { modelEventStream, type ModelTurn } from "./model-route-turn.js";

export type {
  ToolCall,
  AssistantMessage,
  RouteMessage,
  ToolDefinition,
  ModelRouteRequest,
  ValidationFailure,
} from "./model-route-request.js";

export type { ModelStreamEvent, ModelUsage, ToolCallDelta } from "./model-route-events.js";

type CredentialHolders = Readonly<{
  getByName(name: string): Readonly<{
    chatgptAccess(rejected?: string): Promise<ChatGPTAccess>;
    markChatGPTRefused(accessToken: string): Promise<void>;
    markChatGPTUsageLimited(accessToken: string, limitedUntil: number | null): Promise<void>;
  }>;
}>;

type ModelRouteEnv = Readonly<{
  AI: WorkersAiBinding;
  SUPERVISOR: CredentialHolders;
  CHATGPT_MODEL: string;
}>;

export type ModelRouteProps = Readonly<{ supervisor: string }> | undefined;

export class ModelRoute extends WorkerEntrypoint<ModelRouteEnv, ModelRouteProps> {
  runStream(request: RouteWire): ReadableStream<Uint8Array> | ValidationFailure {
    const parsed = parseRequest(request);

    if (Result.isFailure(parsed)) return parsed.failure;
    const validated = parsed.success;

    const workersAi = workersAiTurn(
      { run: (model, input, signal) => this.env.AI.run(model, input, { signal }) },
      validated,
    );

    const credential = this.#chatgptCredential();

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
      chatgpt(emit).pipe(
        Effect.catchTags({
          ChatGPTNotConnected: () => workersAi(emit),
          ChatGPTUsageLimited: ({ limitedUntil }) => {
            emit({ type: "provider-fallback", reason: "chatgpt-usage-limit", limitedUntil });

            return workersAi(emit);
          },
        }),
      );

    return modelEventStream(turn);
  }

  #chatgptCredential(): ChatGPTCredential | undefined {
    const name = this.ctx.props?.supervisor;

    if (name === undefined) return undefined;
    const holder = this.env.SUPERVISOR.getByName(name);

    return {
      access: (rejected) => holder.chatgptAccess(rejected),
      markRefused: (accessToken) => holder.markChatGPTRefused(accessToken),
      markUsageLimited: (accessToken, limitedUntil) =>
        holder.markChatGPTUsageLimited(accessToken, limitedUntil),
    };
  }
}
