import { TURN_DIFF_COMMAND } from "../../../src/facet/generation-0/turn-policy.js";
import { FakeExecBackend } from "../../workspace/project/fakes.js";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "../../../src/workspace/project/index.js";
import type { FakeProjectFilesystemProvider } from "../../workspace/project/fakes.js";

/**
 * An exec backend that answers the harness's diff command by diffing, not by replaying a string a
 * test wrote.
 *
 * workerd runs no child process, so no test in this repository can start a real `git`. The round-2
 * review's objection was not that a diff is faked, but that the old test hand-fed the exact bytes
 * it then asserted: it "would still pass with `git diff` renamed to `cat`". This backend removes
 * that: it snapshots the provider's real file bytes at {@link GitDiffExecBackend.commit}, and when
 * the diff command runs it reads the provider's current bytes and computes the unified diff
 * between them. The output is a consequence of what the turn actually wrote through the project
 * capability, so a turn that changes nothing prints nothing however hard a test wishes otherwise.
 */
export class GitDiffExecBackend implements ExecBackend {
  readonly requests: ExecBackendInput[] = [];
  /** What a command other than the diff does to the workspace, the way a real command would. */
  readonly effects = new Map<string, (provider: FakeProjectFilesystemProvider) => void>();
  /** Every command with no registered effect, for a test that drives one event by event. */
  readonly commands = new FakeExecBackend();
  /** Set to make the diff command fail, as it does outside a repository. */
  failure: { stderr: string; exitCode: number } | undefined;
  readonly #provider: FakeProjectFilesystemProvider;
  #committed: ReadonlyMap<string, string>;

  constructor(provider: FakeProjectFilesystemProvider) {
    this.#provider = provider;
    this.#committed = snapshot(provider);
  }

  /** Records the current files as the state `git diff HEAD` compares against. */
  commit(): void {
    this.#committed = snapshot(this.#provider);
  }

  exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
    this.requests.push(input);

    if (input.command === TURN_DIFF_COMMAND) return Promise.resolve(this.#diffHandle(input.cwd));

    const effect = this.effects.get(input.command);

    if (effect === undefined) return this.commands.exec(input);
    effect(this.#provider);

    return Promise.resolve(new ScriptedExecHandle([{ name: "exit", exitCode: 0 }]));
  }

  #diffHandle(cwd: string): ExecBackendHandle {
    if (this.failure !== undefined) {
      return new ScriptedExecHandle([
        { name: "stderr", data: encode(this.failure.stderr) },
        { name: "exit", exitCode: this.failure.exitCode },
      ]);
    }

    const diff = workspaceDiff(this.#committed, snapshot(this.#provider), cwd);
    const events: BackendExecEvent[] = diff === "" ? [] : [{ name: "stdout", data: encode(diff) }];

    return new ScriptedExecHandle([...events, { name: "exit", exitCode: 0 }]);
  }
}

/** A handle whose events are already known, delivered in order and then ended. */
class ScriptedExecHandle implements ExecBackendHandle {
  killCalls = 0;
  readonly #events: BackendExecEvent[];

  constructor(events: readonly BackendExecEvent[]) {
    this.#events = [...events];
  }

  readonly reader = {
    read: (): Promise<{ done: false; value: BackendExecEvent } | { done: true }> => {
      const next = this.#events.shift();

      return Promise.resolve(next === undefined ? { done: true } : { done: false, value: next });
    },
    cancel: (): Promise<void> => Promise.resolve(),
  };

  kill(): Promise<void> {
    this.killCalls += 1;

    return Promise.resolve();
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Every file the provider holds right now, read through its own read path. */
function snapshot(provider: FakeProjectFilesystemProvider): ReadonlyMap<string, string> {
  const files = new Map<string, string>();

  for (const [path, node] of provider.nodes) {
    if (node.type !== "file") continue;
    files.set(path, new TextDecoder().decode(provider.readFileSync(path)));
  }

  return files;
}

const CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
  const lines = text.split("\n");

  if (lines.at(-1) === "") lines.pop();

  return lines;
}

/**
 * The unified diff of one file: the changed region between the common prefix and the common
 * suffix, with a few lines of context on each side. Real `git diff` splits a file into several
 * hunks; one hunk over the changed region is the same statement about the same bytes.
 */
function fileDiff(label: string, before: string | undefined, after: string): string {
  const from = before === undefined ? [] : splitLines(before);
  const to = splitLines(after);
  let start = 0;

  while (start < from.length && start < to.length && from[start] === to[start]) start += 1;
  let endFrom = from.length;
  let endTo = to.length;

  while (endFrom > start && endTo > start && from[endFrom - 1] === to[endTo - 1]) {
    endFrom -= 1;
    endTo -= 1;
  }

  if (endFrom === start && endTo === start) return "";

  const head = Math.max(0, start - CONTEXT_LINES);
  const tailFrom = Math.min(from.length, endFrom + CONTEXT_LINES);
  const tailTo = Math.min(to.length, endTo + CONTEXT_LINES);

  const lines = [
    `diff --git a/${label} b/${label}`,
    before === undefined ? "--- /dev/null" : `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -${from.length === 0 ? 0 : head + 1},${tailFrom - head} +${head + 1},${tailTo - head} @@`,
  ];

  for (const line of from.slice(head, start)) lines.push(` ${line}`);

  for (const line of from.slice(start, endFrom)) lines.push(`-${line}`);

  for (const line of to.slice(start, endTo)) lines.push(`+${line}`);

  for (const line of from.slice(endFrom, tailFrom)) lines.push(` ${line}`);

  return `${lines.join("\n")}\n`;
}

/** The diff of every file under the command's working directory, in path order. */
function workspaceDiff(
  committed: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  cwd: string,
): string {
  const paths = [...new Set([...committed.keys(), ...current.keys()])].toSorted();
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  let diff = "";

  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    diff += fileDiff(path.slice(prefix.length), committed.get(path), current.get(path) ?? "");
  }

  return diff;
}
