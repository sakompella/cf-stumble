import { TaggedError } from "better-result";

/** The response source had no response left for a request the executor made. */
export class ModelSourceExhaustedError extends TaggedError("ModelSourceExhaustedError")<{
  detail: string;
  message: string;
}> {
  constructor(args: { detail: string }) {
    super({ ...args, message: args.detail });
  }
}

/** The injected response source could not produce a valid response. */
export class ModelSourceFailedError extends TaggedError("ModelSourceFailedError")<{
  detail: string;
  message: string;
  cause?: unknown;
}> {
  constructor(args: { detail: string; cause?: unknown }) {
    super({ ...args, message: args.detail });
  }
}

/** Model output does not satisfy the executor's JSON response protocol. */
export class MalformedToolCallError extends TaggedError("MalformedToolCallError")<{
  detail: string;
  message: string;
}> {
  constructor(args: { detail: string }) {
    super({ ...args, message: args.detail });
  }
}

/** Model output named a tool outside the executor's primitive registry. */
export class UnknownToolError extends TaggedError("UnknownToolError")<{
  toolName: string;
  message: string;
}> {
  constructor(args: { toolName: string }) {
    super({ ...args, message: `unknown tool ${JSON.stringify(args.toolName)}` });
  }
}

/** The model continued requesting tools after the turn's bounded step budget. */
export class StepBudgetExceededError extends TaggedError("StepBudgetExceededError")<{
  maxSteps: number;
  message: string;
}> {
  constructor(args: { maxSteps: number }) {
    super({ ...args, message: `turn exceeded its ${args.maxSteps}-step budget` });
  }
}

/** The workspace could not be recorded as a replay transcript. */
export class TranscriptSnapshotError extends TaggedError("TranscriptSnapshotError")<{
  detail: string;
  message: string;
  cause: unknown;
}> {
  constructor(args: { detail: string; cause: unknown }) {
    super({ ...args, message: `transcript snapshot failed: ${args.detail}` });
  }
}
