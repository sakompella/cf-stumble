import * as Schema from "effect/Schema";
import type { Endpoint } from "./endpoints.js";

const Generation = Schema.Struct({
  label: Schema.Number,
  harnessCommit: Schema.String,
  status: Schema.Literals(["candidate", "ready", "failed"]),
});

const StatusAnswer = Schema.Struct({
  activeGeneration: Schema.Struct({ generation: Schema.NullOr(Generation), epoch: Schema.Number }),
  mainAhead: Schema.NullOr(Schema.Number),
});

const BuildDiagnostics = Schema.Struct({
  stdoutTail: Schema.String,
  stderrTail: Schema.String,
  truncated: Schema.Boolean,
});

const PreparationProblem = Schema.Union([
  Schema.Struct({ code: Schema.Literal("unknown-generation"), label: Schema.Number }),
  Schema.Struct({
    code: Schema.Literals([
      "stored-module-map-absent",
      "corrupt-artifact",
      "artifact-read-failed",
      "artifact-write-failed",
      "build-workspace-unavailable",
      "build-output-missing",
    ]),
    harnessCommit: Schema.String,
  }),
  Schema.Struct({
    code: Schema.Literal("build-step-failed"),
    harnessCommit: Schema.String,
    step: Schema.String,
    exitCode: Schema.Number,
    diagnostics: BuildDiagnostics,
  }),
  Schema.Struct({
    code: Schema.Literal("build-output-invalid"),
    harnessCommit: Schema.String,
    reason: Schema.String,
  }),
]);

export const Preparation = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    report: Schema.Struct({
      stage: Schema.Literals([
        "ready",
        "mount-failed",
        "deadline-expired",
        "compatibility-mismatch",
        "conversation-failed",
      ]),
      reason: Schema.String,
      generation: Generation,
      effect: Schema.Literals(["recorded", "no-op"]),
    }),
  }),
  Schema.Struct({ ok: Schema.Literal(false), problem: PreparationProblem }),
]);

export const Submitted = Schema.Struct({
  ok: Schema.Literal(true),
  outcome: Schema.Struct({
    kind: Schema.Literal("candidate-submitted"),
    generation: Generation,
    epoch: Schema.Number,
  }),
  preparation: Preparation,
});

const PreparationFailed = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.Literal("preparation-failed") }),
  recorded: Schema.Struct({ label: Schema.Number, harnessCommit: Schema.String }),
});

const SubmitAnswer = Schema.Union([Submitted, PreparationFailed]);

const ControlAnswer = Schema.Struct({
  ok: Schema.Literal(true),
  outcome: Schema.Struct({
    kind: Schema.Literals(["activated", "rolled-back"]),
    generation: Generation,
    epoch: Schema.Number,
    effect: Schema.Literals(["activated", "no-op"]),
    droppedCommit: Schema.optionalKey(Schema.String),
  }),
});

export const ANSWERS = {
  "GET /api/status": StatusAnswer,
  "POST /api/generations/submit": SubmitAnswer,
  "POST /api/generations/activate": ControlAnswer,
  "POST /api/generations/rollback": ControlAnswer,
} as const satisfies Partial<Readonly<Record<Endpoint, Schema.Top>>>;

export type AnsweredEndpoint = keyof typeof ANSWERS;

export type AnswerOf<E extends AnsweredEndpoint> = (typeof ANSWERS)[E]["Type"];

export type PreparationFailed = typeof PreparationFailed.Type;
