import type { ReplaySession } from "../../replay/schema.js";
import type {
  PrimitiveCall as ToolPrimitiveCall,
  PrimitiveFailure,
  PrimitiveOptions,
} from "../../tools/index.js";

export type AgentExecutorOptions = {
  readonly maxSteps?: number;
  readonly primitiveOptions?: PrimitiveOptions;
};

export type ExecuteTurnOptions = {
  readonly name?: string;
  readonly seed?: number;
  readonly nowMs?: number;
};

export type TurnFailure =
  | { readonly kind: "malformed-tool-call"; readonly detail: string }
  | { readonly kind: "unknown-tool"; readonly name: string }
  | {
      readonly kind: "primitive-failure";
      readonly call: ToolPrimitiveCall;
      readonly error: PrimitiveFailure["error"];
    }
  | { readonly kind: "model-source-exhausted"; readonly detail: string }
  | { readonly kind: "model-source-error"; readonly detail: string }
  | { readonly kind: "step-budget-exceeded"; readonly maxSteps: number }
  | { readonly kind: "transcript-error"; readonly detail: string };

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
