// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns -- Request JSON is parsed and validated at this HTTP boundary.
import type { GenerationControlResult, GenerationRequest } from "../supervisor/control/index.js";
import { hasExactKeys, isCount, isRecord, jsonError, readJson } from "./json.js";

export type GenerationControlSupervisor = {
  readonly controlGeneration: (request: GenerationRequest) => Promise<GenerationControlResult>;
};

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

function parseGenerationControlBody(value: unknown): GenerationControlBody | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["label", "observedEpoch", "requestId"])) {
    return undefined;
  }
  const { requestId, observedEpoch, label } = value;
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    requestId.length > MAX_REQUEST_ID_LENGTH ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    !isCount(observedEpoch) ||
    !isCount(label)
  ) {
    return undefined;
  }
  return { requestId, observedEpoch, label };
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
