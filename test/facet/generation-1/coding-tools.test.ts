import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { ModelCapability, TailnetFetch } from "../../../src/facet/conversation-protocol.js";
import { CodingTools } from "../../../src/facet/generation-1/coding-tools.js";
import { ROUTE_MODEL, routeProvider } from "../../../src/facet/generation-1/route-provider.js";
import type { ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";
import { envWithoutGenerations } from "./generation-control.js";
import { NO_LOG, NO_USAGE, replies, scriptedRoute } from "./scripted-route.js";

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

type ToolArgs = BashArgs | Readonly<{ url: string }>;

function callsTool(name: string, args: ToolArgs) {
  return replies([
    {
      type: "done",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", function: { name, arguments: JSON.stringify(args) } }],
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

function runBash(args: BashArgs) {
  return runTool("bash", args);
}

async function runTool(name: string, args: ToolArgs, tailnetFetch?: TailnetFetch) {
  const { capability, requests } = scriptedRoute(callsTool(name, args), answers);
  const harness = await openHarness(capability, tailnetFetch);

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

function openHarness(capability: ModelCapability, tailnetFetch?: TailnetFetch) {
  const models = createModels();
  models.setProvider(routeProvider(capability, NO_LOG));
  const registry = createRegistry();
  registry.install(CodingTools);

  return Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: ({ cwd }) =>
        cwd === undefined ? undefined : envWithoutGenerations({ cwd, target, tailnetFetch }),
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

test("tailnet_fetch gives the model the status, headers and body of one exact URL", async () => {
  const fetched: string[] = [];

  const { requests } = await runTool(
    "tailnet_fetch",
    { url: "http://100.64.0.7/status" },
    (url) => {
      fetched.push(url);

      return Promise.resolve(
        new Response("all up", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    },
  );

  const result = requests[1]?.messages.at(-1);

  expect(fetched).toEqual(["http://100.64.0.7/status"]);
  expect(result?.role).toBe("tool");
  expect(result?.content).toContain("HTTP 200");
  expect(result?.content).toContain("content-type: text/plain");
  expect(result?.content).toContain("all up");
});

test("tailnet_fetch says so when the host provides no tailnet", async () => {
  const { requests } = await runTool("tailnet_fetch", { url: "http://100.64.0.7/status" });
  const result = requests[1]?.messages.at(-1);

  expect(result?.content).toContain("tailnet_fetch is unavailable");
});

test("tailnet_fetch passes the host's refusal to the model", async () => {
  const { requests } = await runTool("tailnet_fetch", { url: "http://100.64.0.9/" }, () =>
    Promise.reject(new Error("the tailnet worker refused this host")),
  );

  expect(requests[1]?.messages.at(-1)?.content).toContain("the tailnet worker refused this host");
});
