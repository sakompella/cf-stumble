import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseHarnessCommit } from "../harness-commit.js";
import type { GenerationControlResult, GenerationRequest } from "../supervisor/control/index.js";
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

    return Response.json(result);
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
 * arrive as the preparation result. A 4xx here means the request was malformed, and a 5xx means the
 * route could not reach a decision at all. Neither carries Supervisor error text.
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
      return Response.json(submitted);
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
