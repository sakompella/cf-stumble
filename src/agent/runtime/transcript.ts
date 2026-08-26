import { assertNever } from "../../git/types.js";
import type { WorkspaceTree } from "../../replay/schema.js";
import type { Workspace } from "../../tools/types.js";
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
      throw new TypeError(`workspace listed ${JSON.stringify(path)} but read returned no file`);
    }
    if (typeof content !== "string") {
      throw new TypeError(`workspace file ${JSON.stringify(path)} is binary and cannot be recorded`);
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
  switch (failure.kind) {
    case "malformed-tool-call":
      return failure.detail;
    case "unknown-tool":
      return `unknown tool ${JSON.stringify(failure.name)}`;
    case "primitive-failure":
      return `primitive ${failure.error.kind} failed for ${failure.call.kind}`;
    case "model-source-exhausted":
    case "model-source-error":
    case "transcript-error":
      return failure.detail;
    case "step-budget-exceeded":
      return `turn exceeded its ${failure.maxSteps}-step budget`;
    default:
      return assertNever(failure, "turn failure");
  }
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
