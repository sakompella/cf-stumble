import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isHarnessCommit, type HarnessCommit } from "../harness-commit.js";
import {
  isGenerationLabel,
  type ActivationCommand,
  type ControlProblemCode,
  type GenerationControlResult,
  type GenerationLabel,
  type Submission,
} from "../supervisor/generations.js";
import type { StartupCheckResult } from "../supervisor/startup-check/index.js";
import { callSupervisor, Count, decodeRequestBody, jsonError } from "./json.js";

export type GenerationControlSupervisor = {
  readonly controlGeneration: (command: ActivationCommand) => Promise<GenerationControlResult>;
};

export type GenerationSubmissionSupervisor = {
  readonly submitGeneration: (harnessCommit: HarnessCommit) => Promise<Submission>;
  readonly prepareGeneration: (label: GenerationLabel) => Promise<StartupCheckResult>;
};

export type GenerationSubmissionResult = Readonly<{
  ok: true;
  outcome: Submission;
  preparation: StartupCheckResult;
}>;

const CONTROL_REFUSAL_STATUS = {
  "unknown-generation": 404,
  "stale-epoch": 409,
  "not-ready": 409,
  "not-previously-active": 409,
  "pi-durable-version-mismatch": 409,
} as const satisfies Record<ControlProblemCode, number>;

function refusalResponse(
  refusal: Extract<GenerationControlResult, { readonly ok: false }>,
): Response {
  return Response.json(refusal, { status: CONTROL_REFUSAL_STATUS[refusal.problem.code] });
}

const GenerationControlBody = Schema.Struct({
  observedEpoch: Count,
  label: Count.pipe(Schema.refine(isGenerationLabel)),
});

type ControlCommandKind = "activate" | "rollback";

const GenerationSubmissionBody = Schema.Struct({
  harnessCommit: Schema.String.pipe(Schema.refine(isHarnessCommit)),
});

export const handleGenerationControl = Effect.fnUntraced(
  function* (request: Request, supervisor: GenerationControlSupervisor, kind: ControlCommandKind) {
    const body = yield* decodeRequestBody(request, GenerationControlBody);

    const result = yield* callSupervisor(() =>
      supervisor.controlGeneration({ kind, label: body.label, observedEpoch: body.observedEpoch }),
    );

    return result.ok ? Response.json(result) : refusalResponse(result);
  },
  (handled, _request, _supervisor, kind) =>
    handled.pipe(
      Effect.catchTag("InvalidRequestBody", () =>
        Effect.succeed(
          jsonError(
            400,
            kind === "activate" ? "invalid-activation-request" : "invalid-rollback-request",
          ),
        ),
      ),
    ),
);

export const handleGenerationSubmission = Effect.fnUntraced(
  function* (request: Request, supervisor: GenerationSubmissionSupervisor) {
    const { harnessCommit } = yield* decodeRequestBody(request, GenerationSubmissionBody);

    const submitted = yield* callSupervisor(() => supervisor.submitGeneration(harnessCommit));

    const result: GenerationSubmissionResult = {
      ok: true,
      outcome: submitted,
      preparation: yield* callSupervisor(() =>
        supervisor.prepareGeneration(submitted.generation.label),
      ),
    };

    return Response.json(result);
  },
  Effect.catchTag("InvalidRequestBody", () =>
    Effect.succeed(jsonError(400, "invalid-submission-request")),
  ),
);
