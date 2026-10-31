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

const GenerationSubmissionBody = Schema.Struct({ harnessCommit: Schema.String });

function command(
  kind: ControlCommandKind,
  body: typeof GenerationControlBody.Type,
): GenerationCommand {
  return kind === "activate"
    ? { kind: "activate", label: body.label, observedEpoch: body.observedEpoch }
    : { kind: "rollback", label: body.label, observedEpoch: body.observedEpoch };
}

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
