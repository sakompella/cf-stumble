import type { Result } from "better-result";
import { logEvent, timed, type LogFields, type LogLevel } from "../../diagnostics.js";
import type { ProjectTurnFrame } from "./turn-frames.js";

/**
 * How one turn appears in the operational log (`docs/agents/design/observability.md`).
 *
 * Every event of a turn carries the same three fields, so an operator can pull one turn's whole
 * history out of Workers Logs: the project, the generation it was admitted against, and a suffix
 * of its lease id. The whole lease id never leaves the Supervisor (`turn-run.ts`); the suffix is
 * enough to tell two turns of one project apart and not enough to present as a lease.
 */
export type TurnTrace = Readonly<{
  projectId: string;
  lease: string;
  generation: number | null;
  admittedAt: number;
}>;

const LEASE_SUFFIX_LENGTH = 8;

export function turnTrace(
  projectId: string,
  leaseId: string,
  generation: number | undefined,
  admittedAt: number,
): TurnTrace {
  return {
    projectId,
    lease: leaseId.slice(-LEASE_SUFFIX_LENGTH),
    generation: generation ?? null,
    admittedAt,
  };
}

export function turnFields(trace: TurnTrace): LogFields {
  return { projectId: trace.projectId, lease: trace.lease, generation: trace.generation };
}

/** The frames a generation forwarded, counted by kind. The frames themselves are never logged. */
export type ForwardedFrameCounts = Readonly<{
  text: number;
  toolStart: number;
  toolResult: number;
  diff: number;
  diffUnavailable: number;
}>;

export const NO_FRAMES: ForwardedFrameCounts = {
  text: 0,
  toolStart: 0,
  toolResult: 0,
  diff: 0,
  diffUnavailable: 0,
};

/** Count one forwarded frame. A terminal frame is the settlement, so it is not counted here. */
export function countFrame(
  counts: ForwardedFrameCounts,
  frame: ProjectTurnFrame,
): ForwardedFrameCounts {
  switch (frame.kind) {
    case "text":
      return { ...counts, text: counts.text + 1 };
    case "tool-start":
      return { ...counts, toolStart: counts.toolStart + 1 };
    case "tool-result":
      return { ...counts, toolResult: counts.toolResult + 1 };
    case "diff":
      return { ...counts, diff: counts.diff + 1 };
    case "diff-unavailable":
      return { ...counts, diffUnavailable: counts.diffUnavailable + 1 };
    case "saved":
    case "turn-failed":
    case "turn-rejected":
    case "save-failed":
    case "stream-invalid":
    case "cancelled":
    case "timed-out":
      return counts;
    default: {
      const exhaustive: never = frame;

      return exhaustive;
    }
  }
}

function frameCountFields(counts: ForwardedFrameCounts): LogFields {
  return {
    frames:
      counts.text + counts.toolStart + counts.toolResult + counts.diff + counts.diffUnavailable,
    textFrames: counts.text,
    toolStartFrames: counts.toolStart,
    toolResultFrames: counts.toolResult,
    diffFrames: counts.diff,
    diffUnavailableFrames: counts.diffUnavailable,
  };
}

type Settlement = Readonly<{ level: LogLevel; fields: LogFields }>;

/**
 * What the terminal frame the Supervisor wrote says about the turn, as log fields. A save and a
 * browser that left are ordinary; a failure Pi reported is degraded; a stream the Supervisor could
 * not read, a save it could not make, and a turn that ran out of time are faults.
 */
function settlement(frame: ProjectTurnFrame): Settlement {
  switch (frame.kind) {
    case "saved":
      return {
        level: "info",
        fields: { revision: frame.revision, messageCount: frame.messageCount },
      };
    case "turn-failed":
      return { level: "warn", fields: { code: frame.code, saved: frame.saved } };
    case "turn-rejected":
      return { level: "warn", fields: { code: frame.code } };
    case "save-failed":
    case "stream-invalid":
      return { level: "error", fields: { code: frame.code } };
    case "timed-out":
      return { level: "error", fields: {} };
    case "cancelled":
      return { level: "info", fields: {} };
    // A forwarded frame is never how a turn ends; `endTurn` writes only the kinds above.
    case "text":
    case "tool-start":
    case "tool-result":
    case "diff":
    case "diff-unavailable":
      return { level: "error", fields: { code: "not-a-terminal-frame" } };
    default: {
      const exhaustive: never = frame;

      return exhaustive;
    }
  }
}

/**
 * The log of one turn's stream: the first frame's arrival, and the settlement with frame counts.
 * It sees every frame but writes at most two events, so nothing is logged per frame.
 */
export class TurnStreamLog {
  readonly #trace: TurnTrace;
  readonly #now: () => number;
  #counts: ForwardedFrameCounts = NO_FRAMES;
  #sawFrame = false;

  constructor(trace: TurnTrace, now: () => number) {
    this.#trace = trace;
    this.#now = now;
  }

  /** Wrap the publisher of forwarded frames so each one is counted on its way to the browser. */
  counting(publish: (frame: ProjectTurnFrame) => void): (frame: ProjectTurnFrame) => void {
    return (frame) => {
      if (!this.#sawFrame) {
        this.#sawFrame = true;
        logEvent("info", "turn.first-frame", {
          ...turnFields(this.#trace),
          sinceAdmitMs: this.#now() - this.#trace.admittedAt,
        });
      }

      this.#counts = countFrame(this.#counts, frame);
      publish(frame);
    };
  }

  /** Log the terminal frame the Supervisor wrote, and hand it back to be published. */
  settled(frame: ProjectTurnFrame): ProjectTurnFrame {
    const settled = settlement(frame);

    logEvent(settled.level, "turn.settled", {
      ...turnFields(this.#trace),
      ending: frame.kind,
      ...settled.fields,
      ...frameCountFields(this.#counts),
      totalMs: this.#now() - this.#trace.admittedAt,
    });

    return frame;
  }
}

/** The turn gave its lease back before it settled, and why. */
export function logLeaseAbandoned(trace: TurnTrace, why: string, level: LogLevel): void {
  logEvent(level, "turn.lease-abandoned", { ...turnFields(trace), why });
}

/** Mount the admitted generation and log how long it took and whether it mounted. */
export function timedTurnMount<T, E extends Readonly<{ code: string }>>(
  trace: TurnTrace,
  mount: () => Result<T, E>,
): Promise<Result<T, E>> {
  return timed(
    "turn.mounted",
    turnFields(trace),
    () => Promise.resolve(mount()),
    (mounted) =>
      mounted.isOk() ? { outcome: "mounted" } : { outcome: mounted.error.code, level: "warn" },
  );
}

/**
 * Reconcile the selected checkout before the turn uses it, and log how long that took.
 * `failure` names the problem code of a provision that did not leave the checkout ready.
 */
export function timedTurnProvision<T>(
  trace: TurnTrace,
  target: "harness" | "repository",
  provision: () => Promise<T>,
  failure: (value: T) => string | undefined,
): Promise<T> {
  return timed("turn.provisioned", { ...turnFields(trace), target }, provision, (value) => {
    const code = failure(value);

    return code === undefined ? { outcome: "ready" } : { outcome: code, level: "warn" };
  });
}
