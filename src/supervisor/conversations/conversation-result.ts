import * as Effect from "effect/Effect";

const MAX_MESSAGE_BYTES = 100_000;

const MAX_REQUEST_ID_LENGTH = 128;

export type ConversationProblem = Readonly<{
  code:
    | "invalid-project-id"
    | "unknown-project-id"
    | "invalid-message"
    | "no-active-generation"
    | "mount-failed"
    | "generation-failed"
    | "workspace-busy";
}>;

export type ConversationResult<T> =
  | (Readonly<{ ok: true }> & T)
  | Readonly<{ ok: false; problem: ConversationProblem }>;

export function fail(code: ConversationProblem["code"]): Effect.Effect<never, ConversationProblem> {
  return Effect.fail({ code });
}

export function answered<T extends object>(
  program: Effect.Effect<T, ConversationProblem>,
): Effect.Effect<ConversationResult<T>> {
  return program.pipe(
    Effect.match({
      onSuccess: (value): ConversationResult<T> => ({ ok: true, ...value }),
      onFailure: (problem): ConversationResult<T> => ({ ok: false, problem }),
    }),
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the message arrives from a client.
export function parseMessage(content: unknown, requestId: unknown) {
  const encoder = new TextEncoder();

  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted client values.
    typeof content === "string" &&
      content.trim() !== "" &&
      encoder.encode(content).byteLength <= MAX_MESSAGE_BYTES &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: see above.
      typeof requestId === "string" &&
      requestId !== "" &&
      requestId.length <= MAX_REQUEST_ID_LENGTH
      ? { content, requestId }
      : undefined
  );
}
