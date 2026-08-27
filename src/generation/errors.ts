import { TaggedError } from "better-result";

/** Why a value supplied to generation construction cannot form a valid commit. */
export type InvalidGenerationInputCondition =
  | "invalid-created-at"
  | "created-at-mismatch"
  | "invalid-parent"
  | "invalid-module-content"
  | "invalid-module-path"
  | "module-path-conflict"
  | "duplicate-module-path"
  | "invalid-author"
  | "invalid-committer";

/**
 * Candidate input could not be turned into a generation. The individual validation conditions
 * share the same 400 disposition, so one error carries the condition rather than creating a
 * class per check.
 */
export class InvalidGenerationInputError extends TaggedError("InvalidGenerationInputError")<{
  condition: InvalidGenerationInputCondition;
  detail: string;
  message: string;
}> {
  constructor(args: { condition: InvalidGenerationInputCondition; detail: string }) {
    super({
      ...args,
      message: `invalid generation input (${args.condition}): ${args.detail}`,
    });
  }
}

/** A request value cannot name a generation because it is not a non-negative safe integer. */
export class InvalidGenerationNumberError extends TaggedError("InvalidGenerationNumberError")<{
  value: number;
  message: string;
}> {
  constructor(args: { value: number }) {
    super({
      ...args,
      message: `generation number must be a non-negative safe integer, got ${args.value}`,
    });
  }
}
