import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import type { HarnessCommit } from "../harness-commit.js";
import * as Schema from "effect/Schema";
import {
  GenerationControlTarget,
  GenerationSubmissionRequest,
  type OwnerStatus,
} from "../generation-requests.js";
import type {
  ActivationCommand,
  GenerationControlResult,
  GenerationLabel,
  Submission,
} from "../supervisor/generation-state.js";
import type { StartupCheckResult } from "../supervisor/startup-check/index.js";
import {
  answer,
  callSupervisor,
  decodeRequestBody,
  type Deployment,
  invalidRequestBody,
  jsonError,
  refusal,
  type Handlers,
  type SupervisorCallFailed,
} from "./json.js";

export type GenerationStatusSupervisor = {
  readonly getStatus: () => Promise<OwnerStatus>;
};

function statusResponse(
  supervisor: GenerationStatusSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.getStatus()).pipe(
    Effect.map((status) => answer("GET /api/status", status)),
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
  readonly scriptVersion: () => Promise<string | null>;
};

type ControlCommandKind = "activate" | "rollback";

const handleGenerationControl = Effect.fnUntraced(
  function* (request: Request, supervisor: GenerationControlSupervisor, kind: ControlCommandKind) {
    const body = yield* decodeRequestBody(request, OwnerControlTarget);

    const result = yield* callSupervisor(() =>
      supervisor.controlGeneration(
        { kind, label: body.label, observedEpoch: body.observedEpoch },
        body.force === true,
      ),
    );

    return result.ok
      ? answer(
          kind === "activate" ? "POST /api/generations/activate" : "POST /api/generations/rollback",
          result,
        )
      : refusal(result);
  },
  (handled, _request, _supervisor, kind) =>
    handled.pipe(
      Effect.catchTag("InvalidRequestBody", () =>
        Effect.succeed(
          jsonError(
            kind === "activate" ? "invalid-activation-request" : "invalid-rollback-request",
          ),
        ),
      ),
    ),
);

function isReady(preparation: Result.Result<StartupCheckResult, unknown>): boolean {
  return (
    Result.isSuccess(preparation) &&
    preparation.success.ok &&
    preparation.success.report.stage === "ready"
  );
}

type Prepared = Result.Result<StartupCheckResult, SupervisorCallFailed>;

const prepareAfterDeploy = Effect.fnUntraced(function* (
  failed: Prepared,
  deployment: Deployment<GenerationSubmissionSupervisor>,
  prepare: (stub: GenerationSubmissionSupervisor) => Effect.Effect<Prepared>,
) {
  const stub = deployment.stub();

  const version = yield* callSupervisor(() => stub.scriptVersion()).pipe(Effect.option);

  if (Option.isNone(version) || version.value === deployment.version) return failed;

  logEvent("warn", "api.preparation-after-deploy", { from: deployment.version, to: version.value });

  return yield* prepare(stub);
});

const handleGenerationSubmission = Effect.fnUntraced(function* (
  request: Request,
  supervisor: GenerationSubmissionSupervisor,
  deployment: Deployment<GenerationSubmissionSupervisor>,
) {
  const { harnessCommit } = yield* decodeRequestBody(request, GenerationSubmissionRequest);

  const submitted = yield* callSupervisor(() => supervisor.submitGeneration(harnessCommit));

  const prepare = (stub: GenerationSubmissionSupervisor) =>
    callSupervisor(() => stub.prepareGeneration(submitted.generation.label)).pipe(Effect.result);

  const first = yield* prepare(supervisor);

  const preparation = isReady(first)
    ? first
    : yield* prepareAfterDeploy(first, deployment, prepare);

  if (Result.isFailure(preparation)) {
    logRedactedCause(
      "api POST /api/generations/submit: preparation-failed",
      preparation.failure.cause,
    );

    return answer(
      "POST /api/generations/submit",
      {
        ok: false,
        error: { code: "preparation-failed" },
        recorded: {
          label: submitted.generation.label,
          harnessCommit: submitted.generation.harnessCommit,
        },
      },
      500,
    );
  }

  return answer("POST /api/generations/submit", {
    ok: true,
    outcome: submitted,
    preparation: preparation.success,
  });
}, invalidRequestBody("invalid-submission-request"));

export const GENERATION_HANDLERS: Handlers<
  GenerationStatusSupervisor & GenerationControlSupervisor & GenerationSubmissionSupervisor,
  | "GET /api/status"
  | "POST /api/generations/submit"
  | "POST /api/generations/activate"
  | "POST /api/generations/rollback"
> = {
  "GET /api/status": (_request, supervisor) => statusResponse(supervisor),
  "POST /api/generations/submit": handleGenerationSubmission,
  "POST /api/generations/activate": (request, supervisor) =>
    handleGenerationControl(request, supervisor, "activate"),
  "POST /api/generations/rollback": (request, supervisor) =>
    handleGenerationControl(request, supervisor, "rollback"),
};
