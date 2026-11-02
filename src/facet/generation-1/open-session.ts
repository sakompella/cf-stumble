import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type HarnessSettings,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ConversationHost, GenerationControl } from "../conversation-protocol.js";
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
  generations: GenerationControl | undefined;
  model: ModelCapability;
  abort(reason: string): void;
}>;

export async function openSession(input: SessionInput): Promise<Session> {
  const { host, generations } = input;
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
          : computerEnv(host, generations, String(conversationId), cwd, invocation.abortSignal),
      onWake: (wake) => {
        void host.arm(wake).catch(() => {
          input.abort("the Supervisor did not arm a wake");
        });
      },
    },
    BACKGROUND_CONTEXT,
  );

  await relayRunningConversations(harness, host, input.abort);

  return { harness, host };
}

async function relayRunningConversations(
  harness: Harness,
  host: ConversationHost,
  abort: (reason: string) => void,
): Promise<void> {
  const graph = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
  let reported = runningConversations(graph.value);

  await host.running(reported);
  graph.start(async (value) => {
    const running = runningConversations(value);

    if (running.join(" ") === reported.join(" ")) return;

    reported = running;
    await host.running(running).catch(() => {
      abort("the Supervisor did not take the running conversations");
    });
  });
}

function runningConversations(graph: TaskGraph): readonly string[] {
  const conversations = Object.values(graph.tasks)
    .filter((task) => !task.background)
    .map((task) => String(task.conversationId));

  return [...new Set(conversations)].toSorted();
}
