import type { ReplaySession } from "../../replay/schema.js";
import type {
  PrimitiveCall as ToolPrimitiveCall,
  PrimitiveError,
  PrimitiveOptions,
} from "../../tools/index.js";
import type {
  MalformedToolCallError,
  ModelSourceExhaustedError,
  ModelSourceFailedError,
  StepBudgetExceededError,
  TranscriptSnapshotError,
  UnknownToolError,
} from "./model-errors.js";

export type AgentExecutorOptions = {
  readonly maxSteps?: number;
  readonly primitiveOptions?: PrimitiveOptions;
};

export type ExecuteTurnOptions = {
  readonly name?: string;
  readonly seed?: number;
  readonly nowMs?: number;
};

/** Every known recoverable failure of a turn. */
export type TurnFailure =
  | PrimitiveError
  | ModelSourceExhaustedError
  | ModelSourceFailedError
  | MalformedToolCallError
  | UnknownToolError
  | StepBudgetExceededError
  | TranscriptSnapshotError;

export type TurnResult =
  | {
      readonly status: "completed";
      readonly response: string;
      readonly trace: readonly ToolPrimitiveCall[];
      readonly transcript: ReplaySession;
    }
  | {
      readonly status: "failed";
      readonly failure: TurnFailure;
      readonly trace: readonly ToolPrimitiveCall[];
    };
