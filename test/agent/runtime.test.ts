import { expect, test } from "vitest";
import { buildGeneration } from "../../src/generation/build.js";
import type { Module } from "../../src/generation/types.js";
import {
  AgentExecutor,
  AgentMaterializationError,
  LiveModelResponseSource,
  RecordedModelResponseSource,
  materializeGeneration,
} from "../../src/agent/runtime/index.js";
import { parseReplaySessionJson, runReplay } from "../../src/replay/index.js";
import { InMemoryWorkspace, parseWorkspacePath } from "../../src/tools/index.js";
import { MemoryStore } from "../../src/storage/memory.js";

const author = {
  name: "Runtime Test",
  email: "runtime@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const encoder = new TextEncoder();

function modules(extra: readonly Module[] = []): readonly Module[] {
  return [
    { path: "prompt.md", content: encoder.encode("system prompt\n"), executable: false },
    { path: "policy.md", content: encoder.encode("allow-all\n"), executable: false },
    ...extra,
  ];
}

async function generation(sourceModules: readonly Module[]) {
  const store = new MemoryStore();
  const built = await buildGeneration(store, {
    modules: sourceModules,
    parent: undefined,
    author,
    createdAt: author.timestamp,
    summary: "runtime test",
  });
  return { store, built };
}

test("materializes prompt, policy, and skills from generation bytes", async () => {
  const { store, built } = await generation(
    modules([
      {
        path: "skills/review.md",
        content: encoder.encode("review instructions\n"),
        executable: false,
      },
    ]),
  );

  await expect(materializeGeneration(store, built.sha)).resolves.toEqual({
    generation: built,
    systemPrompt: "system prompt\n",
    policy: "allow-all\n",
    skills: [{ name: "review", content: "review instructions\n" }],
  });
});

test("fails with the missing required module named", async () => {
  const { store, built } = await generation([
    { path: "prompt.md", content: encoder.encode("system prompt\n"), executable: false },
  ]);

  await expect(materializeGeneration(store, built.sha)).rejects.toEqual(
    new AgentMaterializationError(
      "missing-module",
      "policy.md",
      'required module "policy.md" is missing',
    ),
  );
});

function toolResponse(name: string, args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ type: "tool_call", name, arguments: args });
}

function finalResponse(content = "done"): string {
  return JSON.stringify({ type: "final", content });
}

async function runtime() {
  const { store, built } = await generation(modules());
  const definition = await materializeGeneration(store, built.sha);
  return { definition, workspace: new InMemoryWorkspace() };
}

test("executes a materialized generation through a live model source and primitives", async () => {
  const { definition, workspace } = await runtime();
  const responses = [
    toolResponse("write", { path: "result.txt", content: "from generation\n" }),
    finalResponse("finished"),
  ];
  let responseIndex = 0;
  const source = new LiveModelResponseSource(() => {
    const response = responses[responseIndex];
    responseIndex += 1;
    if (response === undefined) {
      throw new Error("test response source exhausted");
    }
    return response;
  });

  const result = await new AgentExecutor(definition).executeTurn("write a result", source, workspace, {
    name: "runtime-turn",
    seed: 9,
    nowMs: 1_700_000_100_000,
  });

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(result.response).toBe("finished");
    expect(result.transcript.expectedEffects.trace).toEqual([
      { kind: "write", path: "result.txt", content: "from generation\n" },
    ]);
    expect(result.transcript.turns[0]?.modelResponses).toHaveLength(2);
  }
  await expect(workspace.readFile(parseWorkspacePath("result.txt"))).resolves.toBe(
    "from generation\n",
  );
});

test("the same executor and effects work with recorded replay and live sources", async () => {
  const { definition } = await runtime();
  const responses = [
    toolResponse("write", { path: "result.txt", content: "same\n" }),
    finalResponse(),
  ];
  let responseIndex = 0;
  const live = await new AgentExecutor(definition).executeTurn(
    "write a result",
    new LiveModelResponseSource(() => {
      const response = responses[responseIndex];
      responseIndex += 1;
      return response ?? finalResponse();
    }),
    new InMemoryWorkspace(),
    { name: "same-executor", seed: 3, nowMs: 1_700_000_100_000 },
  );
  expect(live.status).toBe("completed");
  if (live.status !== "completed") {
    return;
  }

  const recording = parseReplaySessionJson(JSON.stringify(live.transcript));
  const recordedWorkspace = new InMemoryWorkspace();
  const recorded = await new AgentExecutor(definition).executeTurn(
    "write a result",
    new RecordedModelResponseSource(recording.turns[0]?.modelResponses ?? []),
    recordedWorkspace,
    { name: "same-executor", seed: 3, nowMs: 1_700_000_100_000 },
  );
  expect(recorded).toMatchObject({ status: "completed" });
  await expect(recordedWorkspace.readFile(parseWorkspacePath("result.txt"))).resolves.toBe("same\n");

  const replayed = await runReplay(recording, new AgentExecutor(definition));
  expect(replayed.status).toBe("PASS");
});

async function failedTurn(
  response?: string,
  workspace = new InMemoryWorkspace(),
  maxSteps?: number,
) {
  const { definition } = await runtime();
  const source = new RecordedModelResponseSource(response === undefined ? [] : [
    { requestId: "executor", content: response },
  ]);
  return new AgentExecutor(definition, maxSteps === undefined ? {} : { maxSteps }).executeTurn(
    "test",
    source,
    workspace,
    { name: "failure", seed: 1, nowMs: 1_700_000_100_000 },
  );
}

test("reports distinct typed turn failures", async () => {
  const malformed = await failedTurn("not json");
  expect(malformed).toMatchObject({ status: "failed", failure: { kind: "malformed-tool-call" } });

  const unknown = await failedTurn(toolResponse("explode", {}));
  expect(unknown).toMatchObject({
    status: "failed",
    failure: { kind: "unknown-tool", name: "explode" },
  });

  const primitive = await failedTurn(
    toolResponse("read", { path: "missing.txt" }),
    new InMemoryWorkspace(),
  );
  expect(primitive).toMatchObject({
    status: "failed",
    failure: { kind: "primitive-failure", error: { kind: "file-not-found" } },
  });

  const exhausted = await failedTurn();
  expect(exhausted).toMatchObject({
    status: "failed",
    failure: { kind: "model-source-exhausted" },
  });
});

test("stops a model loop at its configured step budget", async () => {
  const { definition } = await runtime();
  const result = await new AgentExecutor(definition, { maxSteps: 2 }).executeTurn(
    "loop",
    new LiveModelResponseSource(() => toolResponse("write", { path: "loop.txt", content: "x" })),
    new InMemoryWorkspace(),
    { name: "budget", seed: 1, nowMs: 1_700_000_100_000 },
  );

  expect(result).toMatchObject({
    status: "failed",
    failure: { kind: "step-budget-exceeded", maxSteps: 2 },
  });
});
