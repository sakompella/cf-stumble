import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, Type, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type EntryRecord,
  type Extension,
} from "@earendil-works/pi-durable";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CONNECTED_PROJECT_ID,
  CONNECTED_PROJECT_URL,
  HARNESS_LOCATION,
  HARNESS_PROJECT_ID,
  HARNESS_PROJECT_URL,
  HARNESS_SELF_PROJECT_ID,
  type HarnessScenario,
} from "./fixtures.mjs";

export const OPENING_TEXT = "I will run the checks before I change anything.";

export const ANSWER_TEXT = "Verification passed, and EARLIER-EDIT-KEPT is still in the workspace.";

export const TOOL_COMMAND = "pnpm verify";

export const TOOL_OUTPUT = ["tests: 12 passed\n", "lint: clean\n"] as const;

export const MODEL_ERROR = "model-error";

export const HARNESS_THREAD_MARKER = "HARNESS-THREAD";

export const EARLIER_EDIT_MARKER = "EARLIER-EDIT-KEPT";

export function projectLocation(projectId: string): string {
  if (projectId === HARNESS_SELF_PROJECT_ID) {
    return HARNESS_LOCATION;
  }

  if (projectId === HARNESS_PROJECT_ID) {
    return HARNESS_PROJECT_URL;
  }

  return projectId === CONNECTED_PROJECT_ID
    ? CONNECTED_PROJECT_URL
    : `/workspace/projects/${projectId}`;
}

export function seedExchange(projectId: string) {
  const location = projectLocation(projectId);

  const marker =
    projectId === HARNESS_SELF_PROJECT_ID ? HARNESS_THREAD_MARKER : EARLIER_EDIT_MARKER;

  return {
    prompt: `Read the README of ${projectId} at ${location} and say what it is.`,
    reply: `${projectId} is checked out at ${location}. ${marker}`,
  };
}

const SEED_PROMPT = /^Read the README of (\S+) at /u;

function userText(message: Message): string {
  if (message.role !== "user") {
    return "";
  }

  const { content } = message;

  return Array.isArray(content)
    ? content.map((block) => (block.type === "text" ? block.text : "")).join("")
    : content;
}

function answer(scenario: HarnessScenario, messages: readonly Message[]): AssistantMessage {
  const last = messages.at(-1);

  if (last?.role !== "user") {
    return scenario === "model-error"
      ? fauxAssistantMessage("", { stopReason: "error", errorMessage: MODEL_ERROR })
      : fauxAssistantMessage(ANSWER_TEXT);
  }

  const seeded = SEED_PROMPT.exec(userText(last))?.[1];

  if (seeded !== undefined) {
    return fauxAssistantMessage(seedExchange(seeded).reply);
  }

  return fauxAssistantMessage(
    [fauxText(OPENING_TEXT), fauxToolCall("bash", { command: TOOL_COMMAND })],
    { stopReason: "toolUse" },
  );
}

export type Barrier = {
  reached: boolean;
  release: () => void;
  released: Promise<void>;
};

function freshBarrier(): Barrier {
  const barrier = { reached: false, release: (): void => undefined };

  const released = new Promise<void>((resolve) => {
    barrier.release = resolve;
  });

  return { ...barrier, released };
}

function stubTools(scenario: () => HarnessScenario, barrier: Barrier): Extension {
  const bash = defineTool({
    name: "bash",
    description: "Run a shell command in the project",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_args, api, toolContext) => {
      const [first, second] = TOOL_OUTPUT;
      api.output(first);

      if (scenario() === "ready-paused") {
        barrier.reached = true;
        await awaitWithContext(barrier.released, toolContext);
      }

      await sleep(150);
      api.output(second);

      return {};
    },
  });

  return defineExtension({ name: "stub", tools: [bash] });
}

export type Conversations = Readonly<{
  barrier: Barrier;
  submit: (projectId: string, content: string, requestId: string) => Promise<number>;
  watch: (projectId: string) => Promise<AgentEventStream>;
  abort: (projectId: string) => Promise<void>;
  fresh: (projectId: string) => Promise<number>;
  entries: (projectId: string) => Promise<readonly EntryRecord[]>;
  close: () => Promise<void>;
}>;

async function openHarness(scenario: () => HarnessScenario, barrier: Barrier) {
  const faux = fauxProvider({ tokensPerSecond: 80 });

  const respond: FauxResponseFactory = (transcript) => {
    faux.appendResponses([respond]);

    return answer(scenario(), transcript.messages);
  };

  faux.setResponses([respond]);

  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(stubTools(scenario, barrier));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const model = faux.getModel();

  const create = () =>
    harness.createConversation(
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

  return { harness, create };
}

export async function openConversations(scenario: () => HarnessScenario): Promise<Conversations> {
  const barrier = freshBarrier();
  const { harness, create } = await openHarness(scenario, barrier);
  const byProject = new Map<string, Promise<Conversation>>();

  const seeded = async (projectId: string): Promise<Conversation> => {
    const conversation = await create();
    const { prompt } = seedExchange(projectId);
    const submission = await conversation.submit({ type: "input", content: prompt }, context);
    await submission.wait(context);

    return conversation;
  };

  const conversationOf = (projectId: string): Promise<Conversation> => {
    const known = byProject.get(projectId);

    if (known !== undefined) {
      return known;
    }

    const opened = seeded(projectId);
    byProject.set(projectId, opened);

    return opened;
  };

  return {
    barrier,
    submit: async (projectId, content, requestId) => {
      const conversation = await conversationOf(projectId);
      const submission = await conversation.submit({ type: "input", content, requestId }, context);

      return submission.id;
    },
    watch: async (projectId) => watchEvents(harness, (await conversationOf(projectId)).id, context),
    abort: async (projectId) => {
      await (await conversationOf(projectId)).abort(context);
    },
    fresh: async (projectId) => {
      const conversation = create();
      byProject.set(projectId, conversation);

      return (await conversation).id;
    },
    entries: async (projectId) => {
      const view = await (await conversationOf(projectId)).viewState(context);
      const { entries } = view.value;
      view.dispose();

      return entries;
    },
    close: async () => {
      barrier.release();
      await harness.close(context);
    },
  };
}
