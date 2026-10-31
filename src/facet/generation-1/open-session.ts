import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type HarnessSettings } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ConversationHost } from "../conversation-protocol.js";
import type { ModelCapability } from "./capabilities.js";
import { computerEnv } from "./computer-env.js";
import { CfStumblePrompt } from "./prompt.js";
import { ROUTE_MODEL, routeProvider } from "./route-provider.js";

const CONTEXT_BUDGET_TOKENS = 64_000;

const ANSWER_RESERVE_TOKENS = 16_384;

const SETTINGS: HarnessSettings = {
  compaction: {
    reserveTokens: ROUTE_MODEL.contextWindow - CONTEXT_BUDGET_TOKENS + ANSWER_RESERVE_TOKENS,
    keepRecentTokens: 8_000,
    backgroundTokens: 0,
  },
};

export type Session = Readonly<{ harness: Harness; host: ConversationHost }>;

export type SessionInput = Readonly<{
  storage: DurableObjectStorage;
  host: ConversationHost;
  model: ModelCapability;
  abort(reason: string): void;
}>;

export async function openSession(input: SessionInput): Promise<Session> {
  const { host } = input;
  const models = createModels();
  models.setProvider(routeProvider(input.model));
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(CfStumblePrompt);

  const harness = await Harness.open(
    await openDurableObjectSqliteStorage(input.storage),
    {
      models,
      registry,
      settings: SETTINGS,
      env: ({ conversationId, cwd }, invocation) =>
        cwd === undefined
          ? undefined
          : computerEnv(host, String(conversationId), cwd, invocation.abortSignal),
      onWake: (wake) => {
        void host.arm(wake).catch(() => {
          input.abort("the Supervisor did not arm a wake");
        });
      },
    },
    BACKGROUND_CONTEXT,
  );

  return { harness, host };
}
