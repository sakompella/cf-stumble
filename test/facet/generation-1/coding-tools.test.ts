import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { ModelCapability } from "../../../src/facet/conversation-protocol.js";
import { CodingTools } from "../../../src/facet/generation-1/coding-tools.js";
import { createComputerEnv } from "../../../src/facet/generation-1/execution-env.js";
import { ROUTE_MODEL, routeProvider } from "../../../src/facet/generation-1/route-provider.js";
import type { ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";
import { NO_USAGE, replies, scriptedRoute } from "./scripted-route.js";

const refused = () => Promise.reject(new Error("not used"));

const timedOut = `${JSON.stringify({ kind: "terminal", seq: 0, outcome: "timed-out" })}\n`;

const target: ProjectRpcTargetContract = {
  lstat: refused,
  readFile: refused,
  writeFile: refused,
  kill: refused,
  endTurn: refused,
  startExec: () =>
    Promise.resolve({
      ok: true,
      value: { operationId: "op", events: new Response(timedOut).body ?? new ReadableStream() },
    }),
};

type BashArgs = Readonly<{ command: string; timeout?: number }>;

const SERVED = { provider: "chatgpt", model: "gpt-test", effort: "medium" };

function callsBash(args: BashArgs) {
  return replies([
    {
      type: "done",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", function: { name: "bash", arguments: JSON.stringify(args) } }],
      },
      usage: NO_USAGE,
      served: SERVED,
    },
  ]);
}

const answers = replies([
  {
    type: "done",
    message: { role: "assistant", content: "done", tool_calls: [] },
    usage: NO_USAGE,
    served: SERVED,
  },
]);

async function runBash(args: BashArgs) {
  const { capability, requests } = scriptedRoute(callsBash(args), answers);
  const harness = await openHarness(capability);

  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: ROUTE_MODEL.provider, modelId: ROUTE_MODEL.id },
        cwd: "/workspace/project",
      },
    });

    const submission = await root.submit({ type: "input", content: "test" }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);

    if (settled.status !== "done" || settled.type !== "input") throw new Error("input not done");

    const answer = await root.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      BACKGROUND_CONTEXT,
    );

    return { requests, answer: answer?.model?.[0] };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

function openHarness(capability: ModelCapability) {
  const models = createModels();
  models.setProvider(routeProvider(capability));
  const registry = createRegistry();
  registry.install(CodingTools);

  return Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: ({ cwd }) => (cwd === undefined ? undefined : createComputerEnv({ cwd, target })),
    },
    BACKGROUND_CONTEXT,
  );
}

test("a command killed at the model's own timeout says so and names the limit", async () => {
  const { requests } = await runBash({ command: "pnpm test", timeout: 150 });
  const result = requests[1]?.messages.at(-1);

  expect(result?.role).toBe("tool");
  expect(result?.content).toContain(
    "killed at your 150 s timeout after 0 s; the limit is 600 s; rerun with a longer timeout",
  );
});

test("a command killed at the host limit names the limit", async () => {
  const { requests } = await runBash({ command: "pnpm test" });
  const result = requests[1]?.messages.at(-1);

  expect(result?.role).toBe("tool");
  expect(result?.content).toContain("killed at the 600 s limit after 0 s");
});

test("the answer names the provider that served it, and each request keeps one cache key", async () => {
  const { requests, answer } = await runBash({ command: "ls" });

  expect(answer).toMatchObject({
    provider: "chatgpt",
    model: "gpt-test",
    providerThinkingLevel: "medium",
  });

  const keys = requests.map((request) => request.promptCacheKey);

  expect(keys[0]).toEqual(expect.any(String));
  expect(new Set(keys).size).toBe(1);
});
