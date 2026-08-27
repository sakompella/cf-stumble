import { TaggedError } from "better-result";

export const REPLAY_SCHEMA_VERSION = 1 as const;

type ReplaySchemaVersion = typeof REPLAY_SCHEMA_VERSION;

export type WorkspaceFile = {
  readonly path: string;
  readonly content: string;
};

export type WorkspaceTree = readonly WorkspaceFile[];

export type ReadCall = {
  readonly kind: "read";
  readonly path: string;
};

export type WriteCall = {
  readonly kind: "write";
  readonly path: string;
  readonly content: string;
};

export type EditCall = {
  readonly kind: "edit";
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
};

export type BashCall = {
  readonly kind: "bash";
  readonly command: string;
};

/** The only calls a replayed executor may make. */
export type PrimitiveCall = ReadCall | WriteCall | EditCall | BashCall;

export type ReadResult = {
  readonly kind: "read";
  readonly content: string;
};

export type WriteResult = {
  readonly kind: "write";
  readonly bytesWritten: number;
};

export type EditResult = {
  readonly kind: "edit";
  readonly replacements: number;
};

export type BashResult = {
  readonly kind: "bash";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type PrimitiveResult = ReadResult | WriteResult | EditResult | BashResult;

export type CapturedToolResult = {
  readonly call: PrimitiveCall;
  readonly result: PrimitiveResult;
  /** Bash is represented by a captured post-call tree because it may change files. */
  readonly workspaceAfter?: WorkspaceTree;
};

export type RecordedModelResponse = {
  readonly requestId: string;
  readonly content: string;
};

export type ReplayTurn = {
  readonly input: string;
  readonly modelResponses: readonly RecordedModelResponse[];
  readonly capturedToolResults: readonly CapturedToolResult[];
};

export type ReplayClock = {
  /** The wall-clock value exposed to the executor, in milliseconds since Unix epoch. */
  readonly nowMs: number;
};

export type ObservableEffects = {
  readonly trace: readonly PrimitiveCall[];
  readonly finalWorkspace: WorkspaceTree;
};

export type ReplaySession = {
  readonly schemaVersion: ReplaySchemaVersion;
  readonly name: string;
  readonly seed: number;
  readonly clock: ReplayClock;
  readonly initialWorkspace: WorkspaceTree;
  readonly turns: readonly ReplayTurn[];
  readonly expectedEffects: ObservableEffects;
};

/** A persisted or request-supplied replay session does not satisfy the current schema. */
export class ReplaySchemaError extends TaggedError("ReplaySchemaError")<{
  path: string;
  condition: string;
  message: string;
}> {
  constructor(args: { path: string; condition: string }) {
    super({
      ...args,
      message: `replay schema error at ${args.path}: ${args.condition}`,
    });
  }
}
