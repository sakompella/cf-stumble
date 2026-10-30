import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  watchEvents,
  type Conversation,
} from "@earendil-works/pi-durable";

/**
 * A real Pi Durable conversation on a faux model, so the page's fold is checked against the events
 * Pi actually emits rather than against events a test wrote by hand. The faux model streams slowly
 * enough that partial answers are committed, and its `bash` tool streams two lines of output.
 */

export type PiRun = Readonly<{
  conversation: Conversation;
  /** Every event line the page would have read since it attached, snapshot first. */
  lines: string[];
  /** The `snapshot` line a page that connected now would read first. */
  snapshotLine: () => Promise<string>;
  close: () => Promise<void>;
}>;

async function openConversation(faux: ReturnType<typeof fauxProvider>) {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const bash = defineTool({
    name: "bash",
    description: "Run a command",
    parameters: Type.Object({ command: Type.String() }),
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

  const stream = await watchEvents(harness, conversation.id, context);
  const lines = [JSON.stringify(stream.snapshot)];
  stream.start((events) => {
    lines.push(...events.map((event) => JSON.stringify(event)));

    return Promise.resolve();
  });

  return {
    conversation,
    lines,
    snapshotLine: async () => {
      const again = await watchEvents(harness, conversation.id, context);

      await again.stop();

      return JSON.stringify(again.snapshot);
    },
    close: async () => {
      await stream.stop();
      await harness.close(context);
    },
  };
}

export { context };
