import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { logRedactedCause } from "../diagnostics.js";
import type { HarnessCommit } from "../harness-commit.js";
import * as Schema from "effect/Schema";
import {
  GenerationControlTarget,
  GenerationSubmissionRequest,
  type OwnerStatus,
} from "../generation-requests.js";
import {
  type ActivationCommand,
  type ControlProblemCode,
  type GenerationControlResult,
  type GenerationLabel,
  type Submission,
} from "../supervisor/generations.js";
import type { StartupCheckResult } from "../supervisor/startup-check/index.js";
import {
  callSupervisor,
  decodeRequestBody,
  invalidRequestBody,
  jsonError,
  type SupervisorCallFailed,
} from "./json.js";

export type GenerationStatusSupervisor = {
  readonly getStatus: () => Promise<OwnerStatus>;
};

export function statusResponse(
  supervisor: GenerationStatusSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.getStatus()).pipe(
    Effect.map((status) => Response.json(status)),
  );
}

export type GenerationControlSupervisor = {
  readonly controlGeneration: (
    command: ActivationCommand,
    force: boolean,
  ) => Promise<GenerationControlResult>;
};

const OwnerControlTarget = Schema.Struct({
  ...GenerationControlTarget.fields,
  force: Schema.optional(Schema.Boolean),
});

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
  "facet-compatibility-mismatch": 409,
  "run-active": 409,
  "drops-active-commit": 409,
} as const satisfies Record<ControlProblemCode, number>;

function refusalResponse(
  refusal: Extract<GenerationControlResult, { readonly ok: false }>,
): Response {
  return Response.json(refusal, { status: CONTROL_REFUSAL_STATUS[refusal.problem.code] });
}

type ControlCommandKind = "activate" | "rollback";

export const handleGenerationControl = Effect.fnUntraced(
  function* (request: Request, supervisor: GenerationControlSupervisor, kind: ControlCommandKind) {
    const body = yield* decodeRequestBody(request, OwnerControlTarget);

    const result = yield* callSupervisor(() =>
      supervisor.controlGeneration(
        { kind, label: body.label, observedEpoch: body.observedEpoch },
        body.force === true,
      ),
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

export const handleGenerationSubmission = Effect.fnUntraced(function* (
  request: Request,
  supervisor: GenerationSubmissionSupervisor,
) {
  const { harnessCommit } = yield* decodeRequestBody(request, GenerationSubmissionRequest);

  const submitted = yield* callSupervisor(() => supervisor.submitGeneration(harnessCommit));

  const preparation = yield* callSupervisor(() =>
    supervisor.prepareGeneration(submitted.generation.label),
  ).pipe(Effect.result);

  if (Result.isFailure(preparation)) {
    logRedactedCause(
      "owner-api POST /api/generations/submit: preparation-failed",
      preparation.failure.cause,
    );

    return Response.json(
      {
        ok: false,
        error: { code: "preparation-failed" },
        recorded: {
          label: submitted.generation.label,
          harnessCommit: submitted.generation.harnessCommit,
        },
      },
      { status: 500 },
    );
  }

  const result: GenerationSubmissionResult = {
    ok: true,
    outcome: submitted,
    preparation: preparation.success,
  };

  return Response.json(result);
}, invalidRequestBody("invalid-submission-request"));
