import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { RepeatedCallNote } from "../../../src/facet/generation-1/repeated-call-note.js";
import { ROUTE_MODEL, routeProvider } from "../../../src/facet/generation-1/route-provider.js";
import type { RouteMessage } from "../../../src/model-route-wire/request.js";
import { NO_USAGE, replies, scriptedRoute } from "./scripted-route.js";

const echo = defineTool({
  name: "echo",
  description: "Echo text back",
  parameters: obj({ text: str() }),
  replay: "safe",
  execute: (args) => Promise.resolve({ output: [{ type: "text", text: `echoed ${args.text}` }] }),
});

const callsEcho = (id: string, text: string) =>
  replies([
    {
      type: "done",
      served: { provider: "workers-ai", model: "test-model" },
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, function: { name: "echo", arguments: JSON.stringify({ text }) } }],
      },
      usage: NO_USAGE,
    },
  ]);

const answers = replies([
  {
    type: "done",
    served: { provider: "workers-ai", model: "test-model" },
    message: { role: "assistant", content: "done", tool_calls: [] },
    usage: NO_USAGE,
  },
]);

function toolResult(message: RouteMessage | undefined): string | undefined {
  return message?.role === "tool" ? message.content : undefined;
}

test("a call repeated with the same arguments and result gets a note from its third time in a run", async () => {
  const { capability, requests } = scriptedRoute(
    callsEcho("c1", "hi"),
    callsEcho("c2", "hi"),
    callsEcho("c3", "bye"),
    callsEcho("c4", "hi"),
    callsEcho("c5", "hi"),
    answers,
    callsEcho("c6", "hi"),
    answers,
  );

  const models = createModels();
  models.setProvider(routeProvider(capability));
  const registry = createRegistry();
  registry.install(defineExtension({ name: "echo", tools: [echo] }));
  registry.install(RepeatedCallNote);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);

  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: ROUTE_MODEL.provider, modelId: ROUTE_MODEL.id } },
    });

    for (const content of ["loop", "again"]) {
      const submission = await root.submit({ type: "input", content }, BACKGROUND_CONTEXT);
      expect(await submission.wait(BACKGROUND_CONTEXT)).toMatchObject({ status: "done" });
    }

    const results = requests.map((request) => toolResult(request.messages.at(-1)));

    expect(results.slice(1, 6).map((text) => text?.includes("<harness>"))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(results[4]?.startsWith("echoed hi")).toBe(true);
    expect(results[7]).toBe("echoed hi");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
