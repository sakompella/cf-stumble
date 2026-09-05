import { expect, test, vi } from "vitest";
import { createPiAgentTurnState, runPiAgentTurn } from "../../../src/facet/generation-0/index.js";
import { makeFacetExecutionEnv } from "./execution-env-target.js";
import { assistant, scriptedModel as model, scriptedStream, tick } from "./scripted-model.js";

function completeLargeBashOutput(
  handle:
    | Readonly<{
        push(
          event:
            | Readonly<{ name: "stdout"; data: Uint8Array }>
            | Readonly<{ name: "exit"; exitCode: number }>,
        ): void;
      }>
    | undefined,
): void {
  if (handle === undefined) throw new Error("expected the bash tool to start an execution");
  for (const event of [
    { name: "stdout" as const, data: new TextEncoder().encode("x".repeat(60 * 1024)) },
    { name: "exit" as const, exitCode: 0 },
  ]) {
    handle.push(event);
  }
}

test("hands Pi state to the next turn", async () => {
  const first = scriptedStream([assistant([{ type: "text", text: "Noted." }], "stop")]);
  const opening = await runPiAgentTurn({
    prompt: "Remember the login bug.",
    state: createPiAgentTurnState(model),
    env: makeFacetExecutionEnv().env,
    streamFn: first.streamFn,
  });

  expect(opening.ok).toBe(true);
  if (!opening.ok) return;

  const second = scriptedStream([assistant([{ type: "text", text: "Fixing it." }], "stop")]);
  const continued = await runPiAgentTurn({
    prompt: "Fix it.",
    state: opening.state,
    env: makeFacetExecutionEnv().env,
    streamFn: second.streamFn,
  });

  expect(continued.ok).toBe(true);
  expect(second.contexts[0]?.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
});

test("reaches every supported execution operation through the four stock tools", async () => {
  const { env: base, execBackend } = makeFacetExecutionEnv();
  await base.writeFile("/workspace/data.txt", "before");
  const operationSpies = [
    vi.spyOn(base, "absolutePath"),
    vi.spyOn(base, "readTextFile"),
    vi.spyOn(base, "readBinaryFile"),
    vi.spyOn(base, "writeFile"),
    vi.spyOn(base, "appendFile"),
    vi.spyOn(base, "fileInfo"),
    vi.spyOn(base, "canonicalPath"),
    vi.spyOn(base, "exists"),
    vi.spyOn(base, "createTempFile"),
    vi.spyOn(base, "exec"),
  ];
  const script = scriptedStream([
    assistant(
      [
        { type: "toolCall", id: "read", name: "read", arguments: { path: "data.txt" } },
        {
          type: "toolCall",
          id: "write",
          name: "write",
          arguments: { path: "new.txt", content: "new" },
        },
        {
          type: "toolCall",
          id: "edit",
          name: "edit",
          arguments: { path: "data.txt", edits: [{ oldText: "before", newText: "after" }] },
        },
        { type: "toolCall", id: "bash", name: "bash", arguments: { command: "large-output" } },
      ],
      "toolUse",
    ),
    assistant([{ type: "text", text: "Done." }], "stop"),
  ]);

  const turn = runPiAgentTurn({
    prompt: "Use every tool.",
    state: createPiAgentTurnState(model),
    env: base,
    streamFn: script.streamFn,
  });
  await tick();
  completeLargeBashOutput(execBackend.handles[0]);

  await expect(turn).resolves.toMatchObject({ ok: true });
  for (const spy of operationSpies) expect(spy).toHaveBeenCalled();
});

test("reaches canonicalPath through the write tool alone, with no bash call", async () => {
  const { env: base, execBackend } = makeFacetExecutionEnv();
  const canonicalPath = vi.spyOn(base, "canonicalPath");
  const script = scriptedStream([
    assistant(
      [
        {
          type: "toolCall",
          id: "write",
          name: "write",
          arguments: { path: "queued.txt", content: "queued" },
        },
      ],
      "toolUse",
    ),
    assistant([{ type: "text", text: "Done." }], "stop"),
  ]);

  const outcome = await runPiAgentTurn({
    prompt: "Write one file.",
    state: createPiAgentTurnState(model),
    env: base,
    streamFn: script.streamFn,
  });

  expect(outcome.ok).toBe(true);
  expect(
    canonicalPath,
    "Pi's write tool canonicalizes the path itself through its file mutation queue",
  ).toHaveBeenCalledWith("/workspace/queued.txt");
  expect(execBackend.requests, "no command runs, so no bash prepare hook could have run").toEqual(
    [],
  );
});

test("preserves a tool error as a Pi result instead of rejecting the turn", async () => {
  const script = scriptedStream([
    assistant(
      [{ type: "toolCall", id: "read", name: "read", arguments: { path: "missing.txt" } }],
      "toolUse",
    ),
    assistant([{ type: "text", text: "The file is missing." }], "stop"),
  ]);

  const outcome = await runPiAgentTurn({
    prompt: "Read the missing file.",
    state: createPiAgentTurnState(model),
    env: makeFacetExecutionEnv().env,
    streamFn: script.streamFn,
  });

  expect(outcome.ok).toBe(true);
  expect(outcome.state.messages.at(-2)).toMatchObject({ role: "toolResult", isError: true });
});

test("reports call-limit exhaustion as a failure and makes no ninth model call", async () => {
  const script = scriptedStream(
    Array.from({ length: 8 }, (_, index) =>
      assistant(
        [{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: "data.txt" } }],
        "toolUse",
      ),
    ),
  );
  const { env } = makeFacetExecutionEnv();
  await env.writeFile("/workspace/data.txt", "data");

  const outcome = await runPiAgentTurn({
    prompt: "Keep reading.",
    state: createPiAgentTurnState(model),
    env,
    streamFn: script.streamFn,
  });

  expect(script.contexts).toHaveLength(8);
  expect(outcome).toMatchObject({ ok: false, problem: { code: "model-call-limit" } });
});
