import type { WorkspaceTree } from "../../replay/schema.js";
import type { Workspace, WorkspaceFileContent } from "../../tools/types.js";
import type { ExecuteTurnOptions, TurnFailure } from "./types.js";

type RecordedFile = { readonly path: string; readonly content: string };

export type RecordingOptions = {
  readonly name: string;
  readonly seed: number;
  readonly nowMs: number;
};

export async function snapshotWorkspace(workspace: Workspace): Promise<WorkspaceTree> {
  const files = await workspace.listFiles();
  const snapshot: RecordedFile[] = [];
  for (const path of files) {
    const content = await workspace.readFile(path);
    if (content === undefined) {
      // Not a broken invariant: `readFile` returns `undefined` by contract, and `Workspace`
      // promises nothing about a path surviving between `listFiles` and the read. Once the
      // workspace is a real filesystem the agent's own `bash` can delete a file inside that
      // window, so this has to stay recoverable — `safeSnapshot` turns it into a
      // `TranscriptSnapshotError`, while a panic would escape and take the turn down.
      throw new Error(`workspace listed ${JSON.stringify(path)} but the file was gone by the read`);
    }
    if (!isTextContent(content)) {
      throw new TypeError(
        `workspace file ${JSON.stringify(path)} is binary and cannot be recorded`,
      );
    }
    snapshot.push({ path, content });
  }
  const sorted = [...snapshot];
  sorted.sort(compareRecordedFiles);
  return sorted;
}

function compareRecordedFiles(left: RecordedFile, right: RecordedFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function recordingOptionsFor(options: ExecuteTurnOptions): RecordingOptions {
  const name = options.name ?? "agent-turn";
  const seed = options.seed ?? 0;
  const nowMs = options.nowMs ?? Date.now();
  if (name.length === 0) {
    throw new TypeError("transcript name must not be empty");
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError(`transcript seed must be an unsigned 32-bit integer, got ${seed}`);
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`transcript clock must be finite, got ${nowMs}`);
  }
  return { name, seed, nowMs };
}

export function describeFailure(failure: TurnFailure): string {
  return failure.message;
}

export function errorDetail(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

function isTextContent(content: WorkspaceFileContent): content is string {
  return typeof content === "string";
}
