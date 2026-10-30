import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseHarnessCommit } from "../harness-commit.js";
import type {
  ControlProblemCode,
  GenerationControlResult,
  GenerationCommand,
} from "../supervisor/control/index.js";
import type { StartupCheckResult } from "../supervisor/startup-check/index.js";
import { callSupervisor, Count, decodeRequestBody, InvalidRequestBody, jsonError } from "./json.js";

export type GenerationControlSupervisor = {
  readonly controlGeneration: (command: GenerationCommand) => Promise<GenerationControlResult>;
};

/** `prepareGeneration` never changes the active generation. */
export type GenerationSubmissionSupervisor = GenerationControlSupervisor & {
  readonly prepareGeneration: (label: number) => Promise<StartupCheckResult>;
};

type SubmissionOutcome = Extract<GenerationControlResult, { readonly ok: true }>["outcome"];

export type GenerationSubmissionResult =
  | {
      readonly ok: true;
      readonly outcome: SubmissionOutcome;
      readonly preparation: StartupCheckResult;
    }
  | Extract<GenerationControlResult, { readonly ok: false }>;

/**
 * 400 is a request the Supervisor can never accept, 404 an unknown label, 409 a request current
 * state refuses, such as a stale epoch. The table is total over the codes, so a new code fails the
 * compiler until someone picks its status.
 */
const CONTROL_REFUSAL_STATUS = {
  "invalid-harness-commit": 400,
  "invalid-generation-label": 400,
  "unknown-generation": 404,
  "stale-epoch": 409,
  "not-ready": 409,
  "not-previously-active": 409,
} as const satisfies Record<ControlProblemCode, number>;

function refusalResponse(
  refusal: Extract<GenerationControlResult, { readonly ok: false }>,
): Response {
  return Response.json(refusal, { status: CONTROL_REFUSAL_STATUS[refusal.problem.code] });
}

const GenerationControlBody = Schema.Struct({ observedEpoch: Count, label: Count });

type ControlCommandKind = "activate" | "rollback";

/**
 * A submission carries no observed epoch, since labeling and checking decide nothing about what
 * serves; a body with one is malformed rather than stale.
 */
const GenerationSubmissionBody = Schema.Struct({ harnessCommit: Schema.String });

function command(
  kind: ControlCommandKind,
  body: typeof GenerationControlBody.Type,
): GenerationCommand {
  return kind === "activate"
    ? { kind: "activate", label: body.label, observedEpoch: body.observedEpoch }
    : { kind: "rollback", label: body.label, observedEpoch: body.observedEpoch };
}

/** There is no request journal, so a rejected request is a fresh decision from current state. */
export const handleGenerationControl = Effect.fnUntraced(
  function* (request: Request, supervisor: GenerationControlSupervisor, kind: ControlCommandKind) {
    const body = yield* decodeRequestBody(request, GenerationControlBody);

    const result = yield* callSupervisor(() => supervisor.controlGeneration(command(kind, body)));

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

/**
 * A build failure or failed startup check is a recorded outcome, so it keeps HTTP 200 and arrives as
 * the preparation result. A 4xx means a malformed request or a refused label, a 5xx means no
 * decision; neither carries Supervisor error text.
 *
 * Resubmitting runs the preparation again, and a differing outcome replaces the recorded one, so a
 * check that failed on a slow cold start does not mark the commit failed forever.
 */
export const handleGenerationSubmission = Effect.fnUntraced(
  function* (request: Request, supervisor: GenerationSubmissionSupervisor) {
    const body = yield* decodeRequestBody(request, GenerationSubmissionBody);
    const harnessCommit = parseHarnessCommit(body.harnessCommit);

    if (harnessCommit === undefined) {
      return yield* new InvalidRequestBody();
    }

    const submitted = yield* callSupervisor(() =>
      supervisor.controlGeneration({ kind: "submit-candidate", harnessCommit }),
    );

    if (!submitted.ok) {
      return refusalResponse(submitted);
    }

    const result: GenerationSubmissionResult = {
      ok: true,
      outcome: submitted.outcome,
      preparation: yield* callSupervisor(() =>
        supervisor.prepareGeneration(submitted.outcome.generation.label),
      ),
    };

    return Response.json(result);
  },
  Effect.catchTag("InvalidRequestBody", () =>
    Effect.succeed(jsonError(400, "invalid-submission-request")),
  ),
);
