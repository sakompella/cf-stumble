import { expect, test } from "vitest";
import type { JsonObject } from "../../src/json.js";
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

function toolResponse(name: string, args: JsonObject): string {
  return JSON.stringify({ type: "tool_call", name, arguments: args });
}

function finalResponse(content = "done"): string {
  return JSON.stringify({ type: "final", content });
}

function allPrimitiveResponse(): string {
  return JSON.stringify({
    type: "tool_calls",
    calls: [
      { name: "read", arguments: { path: "README.md" } },
      { name: "write", arguments: { path: "notes.txt", content: "created\n" } },
      { name: "edit", arguments: { path: "src/app.ts", oldText: "1", newText: "2" } },
      { name: "bash", arguments: { command: "printf 'ok\\n'" } },
    ],
  });
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

  const result = await new AgentExecutor(definition).executeTurn(
    "write a result",
    source,
    workspace,
    {
      name: "runtime-turn",
      seed: 9,
      nowMs: 1_700_000_100_000,
    },
  );

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

test("dispatches all four real primitives and feeds results into the next model request", async () => {
  const { definition } = await runtime();
  const workspace = new InMemoryWorkspace({
    files: [
      { path: "README.md", content: "hello\n" },
      { path: "src/app.ts", content: "const answer = 1;\n" },
    ],
    executeCommand: () => ({ status: "completed", exitCode: 0, stdout: "ok\n", stderr: "" }),
  });
  const response = allPrimitiveResponse();
  let requestCount = 0;
  const result = await new AgentExecutor(definition).executeTurn(
    "exercise every primitive",
    new LiveModelResponseSource((request) => {
      requestCount += 1;
      expect(request.definition.systemPrompt).toBe("system prompt\n");
      if (requestCount === 1) {
        expect(request.toolResults).toEqual([]);
        return response;
      }
      expect(request.toolResults.map((toolResult) => toolResult.kind)).toEqual([
        "read",
        "write",
        "edit",
        "bash",
      ]);
      return finalResponse();
    }),
    workspace,
    { name: "all-primitives", seed: 4, nowMs: 1_700_000_100_000 },
  );

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(result.transcript.expectedEffects.trace).toHaveLength(4);
    const replayed = await runReplay(
      parseReplaySessionJson(JSON.stringify(result.transcript)),
      new AgentExecutor(definition),
    );
    expect(replayed.status).toBe("PASS");
  }
  await expect(workspace.readFile(parseWorkspacePath("notes.txt"))).resolves.toBe("created\n");
  await expect(workspace.readFile(parseWorkspacePath("src/app.ts"))).resolves.toBe(
    "const answer = 2;\n",
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
  await expect(recordedWorkspace.readFile(parseWorkspacePath("result.txt"))).resolves.toBe(
    "same\n",
  );

  const replayed = await runReplay(recording, new AgentExecutor(definition));
  expect(replayed.status).toBe("PASS");
});

async function failedTurn(
  response?: string,
  workspace = new InMemoryWorkspace(),
  maxSteps?: number,
) {
  const { definition } = await runtime();
  const source = new RecordedModelResponseSource(
    response === undefined ? [] : [{ requestId: "executor", content: response }],
  );
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
