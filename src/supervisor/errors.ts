import { TaggedError } from "better-result";

export class InvalidRequestError extends TaggedError("InvalidRequestError")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

export class MissingResourceError extends TaggedError("MissingResourceError")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

export type SafetyViolationKind = "not-live" | "quarantined";

export class SafetyViolationError extends TaggedError("SafetyViolationError")<{
  kind: SafetyViolationKind;
  message: string;
}> {
  constructor(kind: SafetyViolationKind, message: string) {
    super({ kind, message });
  }
}
