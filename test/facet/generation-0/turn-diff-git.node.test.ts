import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { createFacetExecutionEnv } from "../../../src/facet/generation-0/execution-env.js";
import {
  TOOL_RESULT_DISPLAY_MAX_BYTES,
  TOOL_RESULT_DISPLAY_MAX_LINES,
} from "../../../src/facet/generation-0/turn-policy.js";
import { diffFrame } from "../../../src/facet/generation-0/turn-frames.js";
import { readWorkspaceDiff } from "../../../src/facet/generation-0/workspace-diff.js";
import { WORKSPACE_ROOT } from "../../../src/workspace-layout.js";
import { RealProcessProjectTarget } from "./real-process-project-target.js";
import type { FacetTurnFrame } from "../../../src/facet/generation-0/turn-frames.js";

/**
 * The turn's diff, over a real Git repository, through the production execution path.
 *
 * Two earlier attempts at this property proved nothing. The first hand-fed the stdout it then
 * asserted; the second computed a unified diff in TypeScript and gave that behaviour to whatever
 * command `TURN_DIFF_COMMAND` happened to name, so it followed production instead of binding it
 * and stayed green when a reviewer replaced `git --no-pager diff HEAD` with `cat`. Nothing in
 * this file imports that constant, and nothing in it can produce a diff: every expectation below
 * is a file change this test made with `node:fs` and states in its own words, and the only thing
 * that can turn those changes into a diff is the `git` on this machine.
 *
 * workerd starts no child process, which is why this file runs in the Node test project (see
 * `vitest.config.ts`). Above the process boundary the code under test is the deployed code:
 * `readWorkspaceDiff` chooses and bounds the command, `createFacetExecutionEnv` and
 * `execViaProjectTarget` carry it across the project RPC surface, `startExecOperation` frames the
 * output, and `diffFrame` builds the frame a browser receives. Only the `RpcTarget` class itself
 * is stood in for, because `cloudflare:workers` cannot be imported here.
 *
 * ## The contract these tests pin
 *
 * `git diff HEAD`, run in the project directory when the turn ends, reports the repository's
 * tracked changes against `HEAD`. That is not the same statement as "what this turn changed", and
 * the difference is three separate facts, each pinned by a test below:
 *
 * - dirt that was already in the working tree before the turn began is included;
 * - a file the turn created and never staged is not included;
 * - a change the turn committed is not included.
 *
 * Goal criterion 4 asks for a turn that edits an existing file and shows the diff of that edit,
 * which is the first mechanism and the first test. ADR-0040 records the contract and why the
 * other two cases are stated rather than closed.
 */

const PROJECT_PATH = "projects/answers";

/** The turn's starting directory, as the harness addresses it inside the tenant's workspace. */
const PROJECT_CWD = `${WORKSPACE_ROOT}/${PROJECT_PATH}`;

const ANSWER_41 = "export function answer() {\n  return 41;\n}\n";
const ANSWER_42 = "export function answer() {\n  return 42;\n}\n";

/** Runs one Git command in a directory, with an identity so a commit needs no host configuration. */
function git(directory: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "user.email=turn@example.test", "-c", "user.name=Turn", ...args], {
    cwd: directory,
    stdio: "pipe",
  });
}

function write(directory: string, name: string, content: string): void {
  writeFileSync(`${directory}/${name}`, content);
}

/** A temporary directory standing in for the tenant's workspace, holding one empty repository. */
function workspaceWithRepository(): { workspace: string; project: string } {
  const workspace = mkdtempSync(`${tmpdir()}/cf-stumble-turn-diff-`);
  const project = `${workspace}/${PROJECT_PATH}`;
  mkdirSync(project, { recursive: true });
  git(project, ["init", "-b", "main"]);
  return { workspace, project };
}

/** A repository whose only commit holds `answer.ts` returning 41. */
function committedAnswer(): { workspace: string; project: string } {
  const created = workspaceWithRepository();
  write(created.project, "answer.ts", ANSWER_41);
  git(created.project, ["add", "answer.ts"]);
  git(created.project, ["commit", "-m", "the answer is 41"]);
  return created;
}

/** Runs the production diff path in `cwd` and returns the frame a reader would receive. */
async function turnDiffFrame(workspace: string, cwd = PROJECT_CWD): Promise<FacetTurnFrame> {
  const env = createFacetExecutionEnv({
    cwd,
    projectTarget: new RealProcessProjectTarget(workspace),
  });
  return diffFrame(await readWorkspaceDiff(env, new AbortController().signal));
}

function availableDiff(frame: FacetTurnFrame): Extract<FacetTurnFrame, { kind: "diff" }> {
  if (frame.kind !== "diff") throw new Error(`expected a diff frame, received ${frame.kind}`);
  return frame;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A file of numbered lines, and the same file with every line changed. */
function numberedLines(count: number, changed: boolean): string {
  const lines: string[] = [];
  for (let line = 0; line < count; line++) {
    lines.push(changed ? `  const after${line} = ${line};` : `  const before${line} = ${line};`);
  }
  return `${lines.join("\n")}\n`;
}

test("the diff is git's own report of the edit this test left in the working tree", async () => {
  const { workspace, project } = committedAnswer();
  // A second repository in the same workspace, dirty in a way the project's diff must not mention:
  // the command runs in the selected project's directory, not in the workspace root.
  const sibling = `${workspace}/projects/other`;
  mkdirSync(sibling, { recursive: true });
  git(sibling, ["init", "-b", "main"]);
  write(sibling, "sibling.ts", "export const one = 1;\n");
  git(sibling, ["add", "sibling.ts"]);
  git(sibling, ["commit", "-m", "seed"]);
  write(sibling, "sibling.ts", "export const two = 2;\n");

  // The one change this test makes in the project, stated before the diff is read.
  write(project, "answer.ts", ANSWER_42);

  const diff = availableDiff(await turnDiffFrame(workspace));

  expect(diff.truncated).toBe(false);
  expect(diff.content).toContain("diff --git a/answer.ts b/answer.ts");
  expect(diff.content).toContain("-  return 41;");
  expect(diff.content).toContain("+  return 42;");
  expect(diff.content.split("\n").filter((line) => line.startsWith("diff --git"))).toHaveLength(1);
  expect(diff.content, "the sibling repository is not this turn's project").not.toContain(
    "sibling.ts",
  );
});

test("dirt already in the working tree is part of the diff, so the frame is not this turn's delta", async () => {
  const { workspace, project } = committedAnswer();
  write(project, "notes.md", "# notes\n");
  git(project, ["add", "notes.md"]);
  git(project, ["commit", "-m", "notes"]);
  // Left behind before the turn began, by a person or an earlier turn.
  write(project, "notes.md", "# notes\nleft behind before the turn\n");

  // The turn's own change.
  write(project, "answer.ts", ANSWER_42);

  const diff = availableDiff(await turnDiffFrame(workspace));

  expect(diff.content, "the turn's own edit").toContain("+  return 42;");
  expect(diff.content, "and the dirt that was there first").toContain(
    "+left behind before the turn",
  );
});

test("a file the turn created and never staged is absent from the diff", async () => {
  const { workspace, project } = committedAnswer();
  write(project, "answer.ts", ANSWER_42);
  write(project, "created.ts", "export const created = true;\n");

  const diff = availableDiff(await turnDiffFrame(workspace));

  expect(diff.content, "the tracked edit is reported").toContain("+  return 42;");
  expect(diff.content, "`git diff HEAD` does not see an untracked file").not.toContain(
    "created.ts",
  );
});

test("a change the turn committed is absent from the diff", async () => {
  const { workspace, project } = committedAnswer();
  write(project, "answer.ts", ANSWER_42);
  git(project, ["add", "answer.ts"]);
  git(project, ["commit", "-m", "the answer is 42"]);

  const diff = availableDiff(await turnDiffFrame(workspace));

  expect(diff.content, "HEAD moved with the commit, so nothing differs from it").toBe("");
  expect(diff.truncated).toBe(false);
});

test("a repository a turn left clean prints nothing", async () => {
  const { workspace } = committedAnswer();

  const diff = availableDiff(await turnDiffFrame(workspace));

  expect(diff.content).toBe("");
  expect(diff.truncated).toBe(false);
});

/**
 * Git's wording here belongs to Git, and this is the case where that matters most. The deleted
 * fake claimed the detail read `fatal: not a git repository (or any of the parent directories):
 * .git` and exited 128; the `git diff` of version 2.55 warns `Not a git repository. Use
 * --no-index ...` and exits 129 instead. So the assertion pins the fact — the frame carries the
 * repository's own complaint about not being one — and not a sentence this repository invented.
 * (The temporary directory is under the system temp directory, which is assumed not to be inside
 * a Git repository; if it were, Git would find that one and report it instead.)
 */
test("a directory that is no repository answers in git's own words, not with an empty diff", async () => {
  const workspace = mkdtempSync(`${tmpdir()}/cf-stumble-turn-diff-`);
  mkdirSync(`${workspace}/${PROJECT_PATH}`, { recursive: true });
  write(`${workspace}/${PROJECT_PATH}`, "answer.ts", ANSWER_42);

  const frame = await turnDiffFrame(workspace);

  if (frame.kind !== "diff-unavailable") {
    throw new Error(`expected a diff-unavailable frame, received ${frame.kind}`);
  }
  expect(frame.detail.toLowerCase()).toContain("not a git repository");
});

test("a diff larger than the frame budget is bounded, marked, and keeps its end", async () => {
  const { workspace, project } = committedAnswer();
  write(project, "lines.ts", numberedLines(3_000, false));
  git(project, ["add", "lines.ts"]);
  git(project, ["commit", "-m", "3000 lines"]);

  write(project, "lines.ts", numberedLines(3_000, true));

  const diff = availableDiff(await turnDiffFrame(workspace));

  expect(diff.truncated).toBe(true);
  expect(byteLength(diff.content)).toBeLessThanOrEqual(TOOL_RESULT_DISPLAY_MAX_BYTES);
  expect(diff.content.split("\n").length).toBeLessThanOrEqual(TOOL_RESULT_DISPLAY_MAX_LINES + 1);
  expect(diff.content, "the end of a diff is what a reader needs").toContain(
    "+  const after2999 = 2999;",
  );
});
