// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns -- Request JSON is parsed and validated at this HTTP boundary.
import { parseHarnessCommit, type HarnessCommit } from "../harness-commit.js";
import type { GenerationControlResult, GenerationRequest } from "../supervisor/control/index.js";
import type { StartupCheckResult } from "../supervisor/startup-check/index.js";
import { hasExactKeys, isCount, isRecord, jsonError, readJson } from "./json.js";

export type GenerationControlSupervisor = {
  readonly controlGeneration: (request: GenerationRequest) => Promise<GenerationControlResult>;
};

/**
 * Submission needs the journaled control operation and the preparation the Supervisor runs for the
 * label that operation returns. `prepareGeneration` resolves the module map for the labeled harness
 * commit and runs the bounded startup check of ADR-0029; it never changes the active generation.
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
type GenerationControlBody = {
  readonly requestId: string;
  readonly observedEpoch: number;
  readonly label: number;
};

type ControlCommandKind = "activate" | "rollback";

const MAX_REQUEST_ID_LENGTH = 200;

/** A journal key must survive SQLite TEXT, so it carries no control character and no lone surrogate. */
const REQUEST_ID_PATTERN = /^[^\p{Cc}\p{Cs}]+$/u;

function isRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

function parseGenerationControlBody(value: unknown): GenerationControlBody | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["label", "observedEpoch", "requestId"])) {
    return undefined;
  }
  const { requestId, observedEpoch, label } = value;
  if (!isRequestId(requestId) || !isCount(observedEpoch) || !isCount(label)) {
    return undefined;
  }
  return { requestId, observedEpoch, label };
}

/**
 * A submission carries only a request ID and a harness commit. ADR-0030 gives the observed epoch to
 * activation and rollback alone, because labeling a commit and checking it decide nothing about
 * what serves, so a body that carries one is malformed rather than stale.
 */
type GenerationSubmissionBody = {
  readonly requestId: string;
  readonly harnessCommit: HarnessCommit;
};

function parseGenerationSubmissionBody(value: unknown): GenerationSubmissionBody | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["harnessCommit", "requestId"])) {
    return undefined;
  }
  const { requestId, harnessCommit } = value;
  if (!isRequestId(requestId) || typeof harnessCommit !== "string") {
    return undefined;
  }
  const parsedHarnessCommit = parseHarnessCommit(harnessCommit);
  return parsedHarnessCommit === undefined
    ? undefined
    : { requestId, harnessCommit: parsedHarnessCommit };
}

function command(
  kind: ControlCommandKind,
  body: GenerationControlBody,
): GenerationRequest["command"] {
  return kind === "activate"
    ? { kind: "activate", label: body.label, observedEpoch: body.observedEpoch }
    : { kind: "rollback", label: body.label, observedEpoch: body.observedEpoch };
}

/**
 * The Supervisor decides activation and rollback, journals the outcome, and returns it. A rejected
 * request is a recorded decision rather than a transport fault, so it keeps HTTP 200 and carries its
 * problem code: replaying the request ID must return the journaled answer with the same status.
 *
 * The principal is fixed here. Cloudflare Access already proved the owner, and the caller never
 * names a tenant, an identity, or a Durable Object.
 */
export async function handleGenerationControl(
  request: Request,
  supervisor: GenerationControlSupervisor,
  kind: ControlCommandKind,
): Promise<Response> {
  const body = parseGenerationControlBody(await readJson(request));
  if (body === undefined) {
    return jsonError(
      400,
      kind === "activate" ? "invalid-activation-request" : "invalid-rollback-request",
    );
  }

  try {
    return Response.json(
      await supervisor.controlGeneration({
        requestId: body.requestId,
        principal: { kind: "user" },
        command: command(kind, body),
      }),
    );
  } catch {
    return jsonError(500, "internal-error");
  }
}

/**
 * Submit a harness commit as a generation candidate. The Supervisor labels the commit through the
 * same journaled control operation that activation uses, then prepares that label: it resolves the
 * module map from the R2 cache or a build of the commit and runs the bounded startup check. Both
 * steps record evidence against the candidate and neither touches the active generation, so the
 * owner learns whether the candidate passed while the generation that serves keeps serving.
 *
 * A build failure and a failed startup check are recorded outcomes, so they keep HTTP 200 and
 * arrive as the preparation result. A 4xx here means the request was malformed, and a 5xx means the
 * route could not reach a decision at all. Neither carries Supervisor error text.
 *
 * One limit. ADR-0030 journals the labeling, so replaying a request ID returns the recorded
 * labeling and never labels the commit twice. The preparation check is a separate recorded
 * operation, so a replay checks the same commit again and returns the evidence that check produced.
 * That repeats work but cannot contradict the earlier answer: the commit fixes the module map, and
 * the Supervisor rejects an outcome that disagrees with the one already recorded.
 */
export async function handleGenerationSubmission(
  request: Request,
  supervisor: GenerationSubmissionSupervisor,
): Promise<Response> {
  const body = parseGenerationSubmissionBody(await readJson(request));
  if (body === undefined) {
    return jsonError(400, "invalid-submission-request");
  }

  try {
    const submitted = await supervisor.controlGeneration({
      requestId: body.requestId,
      principal: { kind: "user" },
      command: { kind: "submit-candidate", harnessCommit: body.harnessCommit },
    });
    if (!submitted.ok) {
      return Response.json(submitted);
    }

    const result: GenerationSubmissionResult = {
      ok: true,
      outcome: submitted.outcome,
      preparation: await supervisor.prepareGeneration(submitted.outcome.generation.label),
    };
    return Response.json(result);
  } catch {
    return jsonError(500, "internal-error");
  }
}
