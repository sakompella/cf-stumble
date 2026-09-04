import { expect, test } from "vitest";
import {
  MAX_MODEL_CALLS,
  MODEL_CALL_LIMIT_NOTE,
  parseSessionDocument,
  runGeneration0Turn,
} from "../../../src/facet/generation-0/index.js";
import {
  FakeModelRoute,
  FakeWorkspace,
  modelUnavailableReply,
  textReply,
  toolCallReply,
  toolResultTexts,
} from "./fakes.js";
import type { TranscriptEntry } from "../../../src/facet/generation-0/index.js";

const CHECK_OUTPUT = { stdout: "1 test passed\n", stderr: "", exitCode: 0 } as const;

function roles(document: string): readonly TranscriptEntry["role"][] {
  const entries = parseSessionDocument(document);
  if (entries === undefined) {
    throw new Error("the turn must write a document it can read back");
  }
  return entries.map((entry) => entry.role);
}

test("reads a file, edits it, runs the configured command, then answers", async () => {
  const route = new FakeModelRoute([
    toolCallReply([{ id: "c1", name: "read_file", arguments: { path: "src/app.ts" } }]),
    toolCallReply([
      {
        id: "c2",
        name: "edit_file",
        arguments: { path: "src/app.ts", old_text: "value = 1", new_text: "value = 2" },
      },
    ]),
    toolCallReply([{ id: "c3", name: "run_command", arguments: { command: "check" } }]),
    textReply("I changed value to 2 and the check passed."),
  ]);
  const workspace = new FakeWorkspace({
    files: { "src/app.ts": "export const value = 1;\n" },
    commands: { check: CHECK_OUTPUT },
  });

  const outcome = await runGeneration0Turn(
    { MODEL: route },
    { prompt: "Set value to 2 and run the check.", document: null },
    workspace,
  );

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;

  expect(outcome.result.text).toBe("I changed value to 2 and the check passed.");
  expect(outcome.result.commands).toEqual([{ command: "check", ...CHECK_OUTPUT }]);
  expect(workspace.files.get("src/app.ts")).toBe("export const value = 2;\n");
  expect(workspace.requests.map((request) => request.kind)).toEqual([
    "read-file",
    "read-file",
    "write-file",
    "run-command",
  ]);
  expect(roles(outcome.result.document)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "assistant",
    "toolResult",
    "assistant",
    "toolResult",
    "assistant",
  ]);
});

test("sends only messages and tools, so no turn can select a model or a reasoning level", async () => {
  const route = new FakeModelRoute([textReply("Nothing to do.")]);

  await runGeneration0Turn({ MODEL: route }, { prompt: "Hello.", document: null });

  const request = route.requests[0];
  expect(request).toBeDefined();
  expect(Object.keys(request ?? {}).toSorted()).toEqual(["messages", "tools"]);
  expect(request?.messages[0]).toMatchObject({ role: "system" });
  expect(request?.tools?.map((tool) => tool.function.name)).toEqual([
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "run_command",
    "git_diff",
  ]);
});

test("continues the saved conversation on the next turn", async () => {
  const first = new FakeModelRoute([textReply("Noted.")]);
  const opening = await runGeneration0Turn(
    { MODEL: first },
    { prompt: "Remember the login bug.", document: null },
  );
  expect(opening.ok).toBe(true);
  if (!opening.ok) return;

  const second = new FakeModelRoute([textReply("Fixing the login bug now.")]);
  const next = await runGeneration0Turn(
    { MODEL: second },
    { prompt: "Fix it.", document: opening.result.document },
  );

  expect(next.ok).toBe(true);
  if (!next.ok) return;
  expect(
    second.requests[0]?.messages.map((message) => message.role),
    "the second turn must resend the earlier conversation",
  ).toEqual(["system", "user", "assistant", "user"]);
  expect(roles(next.result.document)).toEqual(["user", "assistant", "user", "assistant"]);
});

test("a refused workspace request becomes a tool error, not a facet failure", async () => {
  const route = new FakeModelRoute([
    toolCallReply([{ id: "c1", name: "read_file", arguments: { path: "../secret" } }]),
    textReply("That path is outside the project."),
  ]);
  const workspace = new FakeWorkspace({
    refuse: { kind: "read-file", code: "path-outside-root" },
  });

  const outcome = await runGeneration0Turn(
    { MODEL: route },
    { prompt: "Read ../secret.", document: null },
    workspace,
  );

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.result.text).toBe("That path is outside the project.");
  expect(outcome.result.commands).toEqual([]);
  expect(toolResultTexts(route.requests[1] ?? { messages: [] })).toEqual([
    "workspace error: path-outside-root",
  ]);
});

test("a thrown workspace call becomes a tool error, not a facet failure", async () => {
  const route = new FakeModelRoute([
    toolCallReply([{ id: "c1", name: "run_command", arguments: { command: "check" } }]),
    textReply("The workspace is unavailable."),
  ]);
  const workspace = new FakeWorkspace({ commands: { check: CHECK_OUTPUT }, reject: "run-command" });

  const outcome = await runGeneration0Turn(
    { MODEL: route },
    { prompt: "Run the check.", document: null },
    workspace,
  );

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.result.commands).toEqual([]);
  expect(toolResultTexts(route.requests[1] ?? { messages: [] })).toEqual([
    "workspace error: workspace-unavailable",
  ]);
});

test("reports a tool error for a rejected tool call and for a missing workspace", async () => {
  const route = new FakeModelRoute([
    toolCallReply([
      { id: "c1", name: "read_file", arguments: { path: 7 } },
      { id: "c2", name: "teleport", arguments: {} },
      { id: "c3", name: "git_diff", arguments: {} },
    ]),
    textReply("I have no tools that work here."),
  ]);

  const outcome = await runGeneration0Turn(
    { MODEL: route },
    { prompt: "Show me the diff.", document: null },
  );

  expect(outcome.ok).toBe(true);
  expect(toolResultTexts(route.requests[1] ?? { messages: [] })).toEqual([
    "read_file arguments were rejected: path must be a string",
    "no tool named teleport",
    "workspace error: workspace-unavailable",
  ]);
});

test("records a git diff as an executed command", async () => {
  const route = new FakeModelRoute([
    toolCallReply([{ id: "c1", name: "git_diff", arguments: {} }]),
    textReply("Here is the diff."),
  ]);
  const workspace = new FakeWorkspace();

  const outcome = await runGeneration0Turn(
    { MODEL: route },
    { prompt: "What changed?", document: null },
    workspace,
  );

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.result.commands).toEqual([
    {
      command: "git diff",
      stdout: "diff --git a/src/app.ts b/src/app.ts\n",
      stderr: "",
      exitCode: 0,
    },
  ]);
});

test("stops at the model call limit instead of looping", async () => {
  const route = new FakeModelRoute(
    Array.from({ length: MAX_MODEL_CALLS }, (_unused, index) =>
      toolCallReply([{ id: `c${index}`, name: "git_diff", arguments: {} }]),
    ),
  );

  const outcome = await runGeneration0Turn(
    { MODEL: route },
    { prompt: "Keep going.", document: null },
    new FakeWorkspace(),
  );

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(route.requests).toHaveLength(MAX_MODEL_CALLS);
  expect(outcome.result.text).toBe(MODEL_CALL_LIMIT_NOTE);
});

test("reports a model outage and a rejected model request as turn problems", async () => {
  const outage = await runGeneration0Turn(
    { MODEL: new FakeModelRoute([modelUnavailableReply]) },
    { prompt: "Hello.", document: null },
  );
  expect(outage).toEqual({ ok: false, problem: { code: "model-unavailable" } });

  const rejected = await runGeneration0Turn(
    {
      MODEL: new FakeModelRoute([
        { ok: false, error: { code: "invalid-request", reason: "unknown role" } },
      ]),
    },
    { prompt: "Hello.", document: null },
  );
  expect(rejected).toEqual({ ok: false, problem: { code: "invalid-model-request" } });
});

test("refuses a session document this generation did not write", async () => {
  const route = new FakeModelRoute([textReply("unreachable")]);

  for (const document of [
    '{"turns":["earlier"]}',
    "not json",
    '{"harness":"cf-stumble-generation-0","version":2,"entries":[]}',
  ]) {
    const outcome = await runGeneration0Turn({ MODEL: route }, { prompt: "Continue.", document });
    expect(outcome).toEqual({ ok: false, problem: { code: "invalid-session-document" } });
  }
  expect(route.requests, "a refused document must not reach the model").toEqual([]);
});
