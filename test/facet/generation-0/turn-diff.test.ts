import { expect, test } from "vitest";
import {
  TOOL_RESULT_DISPLAY_MAX_BYTES,
  TOOL_RESULT_DISPLAY_MAX_LINES,
} from "../../../src/facet/generation-0/index.js";
import { FakeProjectCapability } from "./fake-project-capability.js";
import {
  calls,
  encode,
  readFrames,
  says,
  ScriptedRoute,
  turnStream,
} from "./facet-turn-helpers.js";
import type { FacetTurnFrame } from "../../../src/facet/generation-0/index.js";
import type { FakeProjectFilesystemProvider } from "../../workspace/project/fakes.js";

/**
 * The diff is a property of the turn, not a hope about the model.
 *
 * Round 2 of the review overturned the earlier claim here: the old test scripted the model to run
 * `git diff` and then hand-fed the stdout it asserted, so it "would still pass with `git diff`
 * renamed to `cat`". Nothing in these tests tells the model to ask for a diff, and nothing tells
 * the exec backend what to print. The harness runs the diff itself after the model stops, and
 * `GitDiffExecBackend` computes it from the provider's real file bytes.
 */

const APP_BEFORE = ["export function answer() {", "  return 41;", "}", ""].join("\n");

/** A committed workspace: files on disk, and a backend that treats them as the state at HEAD. */
function workspace(seed: (provider: FakeProjectFilesystemProvider) => void): FakeProjectCapability {
  const received = FakeProjectCapability.create();
  seed(received.provider);
  received.execBackend.commit();

  return received;
}

function diffFrame(frames: readonly FacetTurnFrame[]): Extract<FacetTurnFrame, { kind: "diff" }> {
  const frame = frames.find((candidate) => candidate.kind === "diff");

  if (frame?.kind !== "diff") throw new Error("the turn must publish its diff");

  return frame;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A file of numbered lines, and the same file with every fourth line changed. */
function numberedLines(count: number, changed: boolean): string {
  const lines: string[] = [];

  for (let line = 0; line < count; line++) {
    lines.push(
      changed && line % 4 === 0
        ? `  const after${line} = ${line};`
        : `  const before${line} = ${line};`,
    );
  }

  return `${lines.join("\n")}\n`;
}

test("a turn that edits a file shows the diff even though the model never asks for one", async () => {
  const received = workspace((provider) => {
    provider.addFile("/workspace/app.ts", encode(APP_BEFORE));
  });

  const route = new ScriptedRoute([
    calls("edit", {
      path: "app.ts",
      edits: JSON.stringify([{ oldText: "return 41;", newText: "return 42;" }]),
    }),
    says("I changed the answer."),
  ]);

  const frames = await readFrames(turnStream(route, received));

  expect(frames.map((frame) => frame.kind)).toEqual([
    "tool-start",
    "tool-result",
    "text",
    "diff",
    "completed",
  ]);
  const asked = frames.some((frame) => frame.kind === "tool-start" && frame.toolName === "bash");
  expect(asked, "the model ran no command at all").toBe(false);

  const diff = diffFrame(frames);
  expect(diff.truncated).toBe(false);
  expect(diff.content).toContain("diff --git a/app.ts b/app.ts");
  expect(diff.content).toContain("-  return 41;");
  expect(diff.content).toContain("+  return 42;");
  // The diff describes the file the turn actually left behind, not a string this test supplied.
  const written = new TextDecoder().decode(received.provider.readFileSync("/workspace/app.ts"));
  expect(written).toContain("return 42;");
});

test("a command that changes nothing produces an empty diff", async () => {
  const received = workspace((provider) => {
    provider.addFile("/workspace/app.ts", encode(APP_BEFORE));
  });

  received.execBackend.effects.set("./check", () => {});

  const route = new ScriptedRoute([
    calls("bash", { command: "./check" }),
    says("The check passed."),
  ]);

  const diff = diffFrame(await readFrames(turnStream(route, received)));

  expect(diff.content, "nothing changed, so the repository has nothing to print").toBe("");
  expect(diff.truncated).toBe(false);
});

test("a turn that only reads publishes no diff at all", async () => {
  const received = workspace((provider) => {
    provider.addFile("/workspace/app.ts", encode(APP_BEFORE));
  });

  const route = new ScriptedRoute([calls("read", { path: "app.ts" }), says("That is the file.")]);

  const frames = await readFrames(turnStream(route, received));

  expect(frames.map((frame) => frame.kind)).toEqual([
    "tool-start",
    "tool-result",
    "text",
    "completed",
  ]);
});

/**
 * The stated budget. `turn-policy.ts` bounds the diff frame at the same two limits Pi's own tools
 * apply to their output, so one frame is never unbounded and a diff that reaches the limit says it
 * was cut. Both diffs here are computed over real file contents a command rewrote.
 */
test("a diff under the frame budget arrives whole, and one over it is bounded and marked", async () => {
  expect(TOOL_RESULT_DISPLAY_MAX_BYTES).toBe(51_200);
  expect(TOOL_RESULT_DISPLAY_MAX_LINES).toBe(2_000);

  const under = await rewriteTurn(200);
  expect(byteLength(under.content)).toBeLessThan(TOOL_RESULT_DISPLAY_MAX_BYTES);
  expect(under.truncated).toBe(false);
  expect(under.content).toContain("-  const before0 = 0;");
  expect(under.content).toContain("+  const after196 = 196;");

  const over = await rewriteTurn(4_000);
  expect(over.truncated).toBe(true);
  expect(byteLength(over.content)).toBeLessThanOrEqual(TOOL_RESULT_DISPLAY_MAX_BYTES);
  expect(over.content.split("\n").length).toBeLessThanOrEqual(TOOL_RESULT_DISPLAY_MAX_LINES + 1);
  expect(over.content, "the end of a diff is what a reader needs").toContain(
    "+  const after3996 = 3996;",
  );
});

/** One turn whose `./rewrite` command really rewrites a file of `count` lines in the workspace. */
async function rewriteTurn(count: number): Promise<Extract<FacetTurnFrame, { kind: "diff" }>> {
  const received = workspace((provider) => {
    provider.addFile("/workspace/lines.ts", encode(numberedLines(count, false)));
  });

  received.execBackend.effects.set("./rewrite", (provider) => {
    provider.addFile("/workspace/lines.ts", encode(numberedLines(count, true)));
  });

  const route = new ScriptedRoute([
    calls("bash", { command: "./rewrite" }),
    says("Rewrote the file."),
  ]);

  return diffFrame(await readFrames(turnStream(route, received)));
}

test("a workspace that cannot answer says so instead of pretending the turn changed nothing", async () => {
  const received = workspace((provider) => {
    provider.addFile("/workspace/app.ts", encode(APP_BEFORE));
  });

  received.execBackend.failure = {
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    exitCode: 128,
  };

  const route = new ScriptedRoute([
    calls("write", { path: "app.ts", content: "changed" }),
    says("Wrote it."),
  ]);

  const frames = await readFrames(turnStream(route, received));

  expect(frames.at(-2)).toEqual({
    kind: "diff-unavailable",
    detail: "fatal: not a git repository (or any of the parent directories): .git",
  });
  expect(frames.at(-1)?.kind).toBe("completed");
});
