import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import {
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type Conversation,
} from "@earendil-works/pi-durable";

export type PiRun = Readonly<{
  conversation: Conversation;
  lines: string[];
  joinedLines: () => Promise<string>;
  close: () => Promise<void>;
}>;

async function openConversation(faux: ReturnType<typeof fauxProvider>) {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const bash = defineTool({
    name: "bash",
    description: "Run a command",
    parameters: obj({ command: str() }),
    execute: async (_args, api) => {
      api.output("line one\n");
      await sleep(150);
      api.output("line two\n");

      return {};
    },
  });

  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tools: [bash] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);

  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      init: (tx, id) =>
        configure(tx, id, {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: "off",
        }),
    },
    context,
  );

  return { harness, conversation };
}

export async function openPiRun(answers: readonly string[]): Promise<PiRun> {
  const faux = fauxProvider({ tokensPerSecond: 60 });
  const { harness, conversation } = await openConversation(faux);

  faux.setResponses([
    fauxAssistantMessage(
      [fauxText("Let me look."), fauxToolCall("bash", { command: "ls" }, { id: "call-1" })],
      { stopReason: "toolUse" },
    ),
    ...answers.map((answer) => fauxAssistantMessage(answer)),
  ]);

  const watch = await conversation.watch(context);
  const lines = [JSON.stringify([["r", watch.value]])];
  watch.start((call) => {
    if (call.kind === "value") lines.push(JSON.stringify(call.ops));

    return Promise.resolve();
  });

  return {
    conversation,
    lines,
    joinedLines: async () => {
      const joined = await conversation.watch(context);
      await joined.stop();

      return JSON.stringify([["r", joined.value]]);
    },
    close: async () => {
      await watch.stop();
      await harness.close(context);
    },
  };
}

export { context };
