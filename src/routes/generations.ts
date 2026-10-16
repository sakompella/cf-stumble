import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseHarnessCommit } from "../harness-commit.js";
import type {
  ControlProblemCode,
  GenerationControlResult,
  GenerationRequest,
} from "../supervisor/control/index.js";
import type { StartupCheckResult } from "../supervisor/startup-check/index.js";
import { callSupervisor, Count, decodeRequestBody, InvalidRequestBody, jsonError } from "./json.js";

export type GenerationControlSupervisor = {
  readonly controlGeneration: (request: GenerationRequest) => Promise<GenerationControlResult>;
};

/**
 * Submission needs the directly-applied control operation (ADR-0030) and the preparation the
 * Supervisor runs for the label that operation returns. `prepareGeneration` resolves the module map
 * for the labeled harness commit and runs the bounded startup check of ADR-0029; it never changes
 * the active generation.
 */
export type GenerationSubmissionSupervisor = GenerationControlSupervisor & {
  readonly prepareGeneration: (label: number) => Promise<StartupCheckResult>;
};

type SubmissionOutcome = Extract<GenerationControlResult, { readonly ok: true }>["outcome"];

/**
 * What the owner reads back from one submission: the generation the Supervisor labeled, and the
 * preparation result recorded against that label. A rejected submission carries the control problem
 * instead and no preparation ran.
 */
export type GenerationSubmissionResult =
  | {
      readonly ok: true;
      readonly outcome: SubmissionOutcome;
      readonly preparation: StartupCheckResult;
    }
  | Extract<GenerationControlResult, { readonly ok: false }>;

/**
 * What each control refusal is, as an HTTP fact. A request the Supervisor can never accept is 400;
 * a label it does not know is 404; a request that current generation state refuses, such as a stale
 * epoch, is 409; and a harness principal whose generation no longer serves is 403. The body keeps
 * `ok: false` and the code, so a client reads the refusal the same way at any status. The table is
 * total over the codes, so a new code fails the compiler here until someone picks its status.
 */
const CONTROL_REFUSAL_STATUS = {
  "invalid-harness-commit": 400,
  "invalid-generation-label": 400,
  "unknown-generation": 404,
  "stale-epoch": 409,
  "not-ready": 409,
  "not-previously-active": 409,
  "revoked-capability": 403,
} as const satisfies Record<ControlProblemCode, number>;

function refusalResponse(
  refusal: Extract<GenerationControlResult, { readonly ok: false }>,
): Response {
  return Response.json(refusal, { status: CONTROL_REFUSAL_STATUS[refusal.problem.code] });
}

/** Activation and rollback take the same request. Only the command differs. */
const GenerationControlBody = Schema.Struct({ observedEpoch: Count, label: Count });

type ControlCommandKind = "activate" | "rollback";

/**
 * A submission carries only a harness commit. ADR-0030 gives the observed epoch to activation and
 * rollback alone, because labeling a commit and checking it decide nothing about what serves, so a
 * body that carries one is malformed rather than stale.
 */
const GenerationSubmissionBody = Schema.Struct({ harnessCommit: Schema.String });

function command(
  kind: ControlCommandKind,
  body: typeof GenerationControlBody.Type,
): GenerationRequest["command"] {
  return kind === "activate"
    ? { kind: "activate", label: body.label, observedEpoch: body.observedEpoch }
    : { kind: "rollback", label: body.label, observedEpoch: body.observedEpoch };
}

/**
 * The Supervisor applies activation and rollback directly to the generation tables and returns the
 * outcome (ADR-0030): there is no request journal, so a rejected request is a fresh decision from
 * current state rather than a replayed one. The principal is fixed here. Cloudflare Access already
 * proved the owner, and the caller never names a tenant, an identity, or a Durable Object.
 */
export const handleGenerationControl = Effect.fnUntraced(
  function* (request: Request, supervisor: GenerationControlSupervisor, kind: ControlCommandKind) {
    const body = yield* decodeRequestBody(request, GenerationControlBody);

    const result = yield* callSupervisor(() =>
      supervisor.controlGeneration({ principal: { kind: "user" }, command: command(kind, body) }),
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

/**
 * Submit a harness commit as a generation candidate. The Supervisor labels the commit directly
 * (ADR-0030: labeling a commit that already has a generation returns the existing generation
 * rather than labeling it twice), then prepares that label: it reads the stored module map or
 * builds and stores the commit, then runs the bounded startup check. Both steps record evidence
 * against the candidate and neither touches the active generation, so the owner learns whether the
 * candidate passed while the generation that serves keeps serving.
 *
 * A build failure and a failed startup check are recorded outcomes, so they keep HTTP 200 and
 * arrive as the preparation result. A 4xx here means the request was malformed or the Supervisor
 * refused to label the commit, and a 5xx means the route could not reach a decision at all. Neither
 * carries Supervisor error text.
 *
 * Resubmitting an already-labeled commit runs the same preparation step again rather than
 * replaying an earlier response. That check is itself idempotent: recording a preparation outcome
 * that agrees with what is already recorded is a no-op, and a genuinely different outcome for the
 * same commit is refused as a contradiction (`contradicts-recorded-outcome`) instead of silently
 * overwriting the first result.
 */
export const handleGenerationSubmission = Effect.fnUntraced(
  function* (request: Request, supervisor: GenerationSubmissionSupervisor) {
    const body = yield* decodeRequestBody(request, GenerationSubmissionBody);
    const harnessCommit = parseHarnessCommit(body.harnessCommit);

    if (harnessCommit === undefined) {
      return yield* new InvalidRequestBody();
    }

    const submitted = yield* callSupervisor(() =>
      supervisor.controlGeneration({
        principal: { kind: "user" },
        command: { kind: "submit-candidate", harnessCommit },
      }),
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
