import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { ModelCapability } from "../../../src/facet/conversation-protocol.js";
import { ROUTE_MODEL, routeProvider } from "../../../src/facet/generation-1/route-provider.js";
import { NO_USAGE, replies, scriptedRoute } from "./scripted-route.js";

const echo = defineTool({
  name: "echo",
  description: "Echo text back",
  parameters: obj({ text: str() }),
  replay: "safe",
  execute: (args) => Promise.resolve({ output: [{ type: "text", text: `echoed ${args.text}` }] }),
});

const callsEcho = replies([
  {
    type: "done",
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", function: { name: "echo", arguments: '{"text":"hi"}' } }],
    },
    usage: NO_USAGE,
  },
]);

const answers = replies([
  { type: "text-delta", delta: "The tool said echoed hi" },
  {
    type: "done",
    message: { role: "assistant", content: "The tool said echoed hi", tool_calls: [] },
    usage: NO_USAGE,
  },
]);

function openHarness(capability: ModelCapability) {
  const models = createModels();
  models.setProvider(routeProvider(capability));
  const registry = createRegistry();
  registry.install(defineExtension({ name: "echo", tools: [echo] }));

  return Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
}

test("a Pi Durable harness answers an input, running a tool, through the provider", async () => {
  const { capability, requests } = scriptedRoute(callsEcho, answers);
  const harness = await openHarness(capability);

  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: ROUTE_MODEL.provider, modelId: ROUTE_MODEL.id } },
    });

    const submission = await root.submit({ type: "input", content: "say hi" }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    if (settled.status !== "done" || settled.type !== "input") throw new Error("input not done");

    const answer = await root.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      BACKGROUND_CONTEXT,
    );

    expect(answer?.model?.[0]?.content).toEqual([
      { type: "text", text: "The tool said echoed hi" },
    ]);

    expect(requests.map((request) => request.messages.at(-1))).toEqual([
      { role: "user", content: "say hi" },
      { role: "tool", tool_call_id: "call_1", content: "echoed hi" },
    ]);

    expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["echo"]);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("a tool call the route reports as cut off is not run, and the run ends with what arrived", async () => {
  const cutOff = replies([
    { type: "text-delta", delta: "Writing the file" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: "Writing the file",
        tool_calls: [{ id: "call_1", function: { name: "echo", arguments: '{"text":"h' } }],
      },
      usage: NO_USAGE,
      truncated: true,
    },
  ]);

  const { capability, requests } = scriptedRoute(cutOff, answers);
  const harness = await openHarness(capability);

  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: ROUTE_MODEL.provider, modelId: ROUTE_MODEL.id } },
    });

    const submission = await root.submit({ type: "input", content: "say hi" }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    if (settled.status !== "done" || settled.type !== "input") throw new Error("input not done");

    const answer = await root.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      BACKGROUND_CONTEXT,
    );

    expect(answer?.model?.[0]).toMatchObject({ stopReason: "length" });
    expect(requests).toHaveLength(1);

    const next = await root.submit({ type: "input", content: "go on" }, BACKGROUND_CONTEXT);
    expect(await next.wait(BACKGROUND_CONTEXT)).toMatchObject({ status: "done" });
    expect(requests[1]?.messages.slice(-3)).toMatchObject([
      { role: "assistant", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1" },
      { role: "user", content: "go on" },
    ]);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
