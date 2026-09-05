import { expect, test } from "vitest";
import {
  TOOL_RESULT_DISPLAY_MAX_BYTES,
  TOOL_RESULT_DISPLAY_MAX_LINES,
} from "../../../src/facet/generation-0/index.js";
import { FakeProjectCapability } from "./fake-project-capability.js";
import { calls, readFrames, says, ScriptedRoute, turnStream } from "./facet-turn-helpers.js";
import { tick } from "./scripted-model.js";
import type { FacetTurnFrame } from "../../../src/facet/generation-0/index.js";

/** A diff of the shape `git diff` prints, at whatever size a test asks for. */
function diffText(hunkLines: number): string {
  const lines = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1a2b3c4..5d6e7f8 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    `@@ -1,${hunkLines} +1,${hunkLines} @@`,
  ];
  for (let line = 0; line < hunkLines; line++) {
    lines.push(
      line % 4 === 0 ? `-  const before${line} = ${line};` : `+  const after${line} = ${line};`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Runs a turn whose model asks `bash` for a diff, answers the command with `stdout`, and returns
 * the frames. Nothing here shortcuts the tool: the command reaches the project RPC target's exec
 * backend and its output comes back through the same NDJSON frame reader a real workspace uses.
 */
async function diffTurn(stdout: string, exitCode = 0): Promise<FacetTurnFrame[]> {
  const received = FakeProjectCapability.create();
  const route = new ScriptedRoute([
    calls("bash", { command: "git diff" }),
    says("That is what changed."),
  ]);
  const frames = readFrames(turnStream(route, received));

  await tick();
  const handle = received.execBackend.handles[0];
  if (handle === undefined) throw new Error("the bash tool must have started a command");
  for (const event of [
    { name: "stdout" as const, data: new TextEncoder().encode(stdout) },
    { name: "exit" as const, exitCode },
  ]) {
    handle.push(event);
  }

  return frames;
}

function toolResult(frames: readonly FacetTurnFrame[]) {
  const frame = frames.find((candidate) => candidate.kind === "tool-result");
  if (frame?.kind !== "tool-result") throw new Error("the turn must publish a tool result");
  return frame;
}

test("the Pi path produces a repository diff through bash, in one tool-result frame", async () => {
  const diff = diffText(40);
  const frames = await diffTurn(diff);

  expect(frames.map((frame) => frame.kind)).toEqual([
    "tool-start",
    "tool-result",
    "text",
    "completed",
  ]);
  expect(frames[0]).toEqual({
    kind: "tool-start",
    toolCallId: "bash-1",
    toolName: "bash",
    arguments: { command: "git diff" },
  });

  const result = toolResult(frames);
  expect(result.isError).toBe(false);
  expect(result.truncated).toBe(false);
  expect(result.content, "a forty-line diff arrives whole").toContain(diff.trimEnd());
});

/**
 * The stated budget. `turn-policy.ts` bounds a tool-result frame at the same two limits Pi's own
 * tools apply to their output, so a frame never truncates a result Pi already bounded. A diff of a
 * few thousand bytes is nowhere near it; a diff that reaches it is cut and says so.
 */
test("a diff just under the frame budget arrives whole, and one over it is bounded and marked", async () => {
  expect(TOOL_RESULT_DISPLAY_MAX_BYTES).toBe(51_200);
  expect(TOOL_RESULT_DISPLAY_MAX_LINES).toBe(2_000);
  expect(byteLength(diffText(40))).toBeLessThan(TOOL_RESULT_DISPLAY_MAX_BYTES / 10);

  const nearBudget = diffText(1_800);
  expect(byteLength(nearBudget)).toBeLessThan(TOOL_RESULT_DISPLAY_MAX_BYTES);
  const under = toolResult(await diffTurn(nearBudget));
  expect(under.truncated).toBe(false);
  expect(under.content).toContain(nearBudget.trimEnd());

  const overBudget = diffText(4_000);
  expect(byteLength(overBudget)).toBeGreaterThan(TOOL_RESULT_DISPLAY_MAX_BYTES);
  const over = toolResult(await diffTurn(overBudget));
  expect(over.truncated).toBe(true);
  expect(byteLength(over.content)).toBeLessThanOrEqual(TOOL_RESULT_DISPLAY_MAX_BYTES);
  expect(over.content, "the end of a diff is what a reader needs").toContain("const after3999");
});

test("a failed command is a tool error frame carrying what the command printed", async () => {
  const frames = await diffTurn("fatal: not a git repository\n", 128);
  const result = toolResult(frames);

  expect(result.isError).toBe(true);
  expect(result.content).toContain("not a git repository");
  expect(frames.at(-1)?.kind).toBe("completed");
});
