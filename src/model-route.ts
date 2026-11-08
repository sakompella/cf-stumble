import { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { GENERATION_REPLACED } from "./generation-replaced.js";
import { chatgptTurn, type ChatGPTAccess, type ChatGPTCredential } from "./chatgpt/index.js";
import { parseRequest, type RouteWire, type ValidationFailure } from "./model-route-request.js";
import { runAtEntryPoint } from "./run-entry-point.js";
import { workersAiTurn } from "./model-route-stream.js";
import type { WorkersAiBinding } from "./model-route-events.js";
import { modelEventStream, type ModelTurn } from "./model-route-turn.js";

type CredentialHolders = Readonly<{
  getByName(name: string): Readonly<{
    admitModelTurn(instance: number): Promise<boolean>;
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

export type ModelRouteProps = Readonly<{ supervisor: string; instance: number }>;

export class ModelRoute extends WorkerEntrypoint<ModelRouteEnv, ModelRouteProps> {
  runStream(request: RouteWire): Promise<ReadableStream<Uint8Array> | ValidationFailure> {
    const parsed = parseRequest(request);

    if (Result.isFailure(parsed)) return Promise.resolve(parsed.failure);
    const validated = parsed.success;
    const holder = this.env.SUPERVISOR.getByName(this.ctx.props.supervisor);

    const workersAi = workersAiTurn(
      { run: (model, input, signal) => this.env.AI.run(model, input, { signal }) },
      validated,
    );

    const chatgpt = chatgptTurn(
      {
        credential: chatgptCredential(holder),
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

    return runAtEntryPoint(
      Effect.promise(() => holder.admitModelTurn(this.ctx.props.instance)).pipe(
        Effect.map((admitted): ReadableStream<Uint8Array> | ValidationFailure =>
          admitted
            ? modelEventStream(turn)
            : { ok: false, error: { code: "invalid-request", reason: GENERATION_REPLACED } },
        ),
      ),
    );
  }
}

function chatgptCredential(holder: ReturnType<CredentialHolders["getByName"]>): ChatGPTCredential {
  return {
    access: (rejected) => holder.chatgptAccess(rejected),
    markRefused: (accessToken) => holder.markChatGPTRefused(accessToken),
    markUsageLimited: (accessToken, limitedUntil) =>
      holder.markChatGPTUsageLimited(accessToken, limitedUntil),
  };
}
