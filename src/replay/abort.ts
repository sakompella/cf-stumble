import type { ReplayInconclusiveReason } from "./runner.js";

export class ReplayAbort extends Error {
  readonly reason: ReplayInconclusiveReason;

  constructor(reason: ReplayInconclusiveReason, detail: string) {
    super(detail);
    this.name = "ReplayAbort";
    this.reason = reason;
  }
}

export function replayAbort(reason: ReplayInconclusiveReason, detail: string): ReplayAbort {
  return new ReplayAbort(reason, detail);
}
