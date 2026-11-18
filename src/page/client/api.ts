import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { AnswerOf, Preparation, SubmissionInterrupted } from "../../api/answers.js";

import { HARNESS_DIRECTORY } from "../../workspace-layout.js";
import { errorWording, problemWording } from "./problem-wording.js";
import type { GenerationReading, Project } from "./model.js";

export { endpointPath } from "../../api/endpoints.js";

export function transportDetail(cause: unknown): string {
  return Predicate.isError(cause) ? cause.message : String(cause);
}

export type JsonBody = Readonly<Record<string, string | number>>;

export function fetchEffect(
  path: string,
  init: Readonly<{ method: "GET" | "POST"; accept: string; maybeBody: Option.Option<JsonBody> }>,
  signal?: AbortSignal,
): Effect.Effect<Response, string> {
  return Effect.tryPromise({
    try: (interrupted) =>
      globalThis.fetch(path, {
        method: init.method,
        credentials: "same-origin",
        headers: Option.isSome(init.maybeBody)
          ? { accept: init.accept, "content-type": "application/json" }
          : { accept: init.accept },
        body: Option.getOrNull(Option.map(init.maybeBody, (body) => JSON.stringify(body))),
        signal: signal ?? interrupted,
      }),
    catch: transportDetail,
  });
}

export type Answer = Readonly<{ status: number; payload: Schema.Json }>;

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

export function answerOf(response: Response): Effect.Effect<Answer> {
  return Effect.promise(() => response.text().catch(() => "")).pipe(
    Effect.map((body) => ({
      status: response.status,
      payload: Option.getOrNull(decodeJsonText(body)),
    })),
  );
}

export type Refusal = Readonly<{ kind: "problem" | "error"; code: string }>;

const Code = Schema.Struct({ code: Schema.String });

const decodeProblem = Schema.decodeUnknownOption(
  Schema.Struct({ ok: Schema.Literal(false), problem: Code }),
);

const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({ ok: Schema.Literal(false), error: Code }),
);

export function decodeRefusal(payload: Schema.Json): Option.Option<Refusal> {
  return Option.orElse(
    Option.map(decodeProblem(payload), ({ problem }) => ({
      kind: "problem" as const,
      code: problem.code,
    })),
    () =>
      Option.map(decodeError(payload), ({ error }) => ({
        kind: "error" as const,
        code: error.code,
      })),
  );
}

export function refusalText(refusal: Refusal): string {
  const known =
    refusal.kind === "problem" ? problemWording(refusal.code) : errorWording(refusal.code);

  return known ?? `${refusal.kind === "problem" ? "rejected" : "error"}: ${refusal.code}`;
}

export function unreadableText(status: number): string {
  return status >= 200 && status < 300
    ? `error: unreadable answer (HTTP ${status})`
    : `error: HTTP ${status}`;
}

export function problemText(answer: Readonly<{ status: number; payload: Schema.Json }>): string {
  return Option.match(decodeRefusal(answer.payload), {
    onNone: () => unreadableText(answer.status),
    onSome: refusalText,
  });
}

export function generationReading(answer: AnswerOf<"GET /api/status">): GenerationReading {
  const { generation, epoch } = answer.activeGeneration;

  return {
    epoch,
    maybeActive: generation === null ? Option.none() : Option.some(generation),
    maybeMainAhead: Option.fromNullishOr(answer.mainAhead),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function checkedWording(checkedAt: number | null, now: number): string {
  if (checkedAt === null || !Number.isFinite(checkedAt)) {
    return "";
  }

  const then = new Date(checkedAt);
  const clock = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;

  return then.toDateString() === new Date(now).toDateString()
    ? clock
    : `${then.getFullYear()}-${pad2(then.getMonth() + 1)}-${pad2(then.getDate())} ${clock}`;
}

export function projectsOf(answer: AnswerOf<"GET /api/projects">): readonly Project[] {
  return answer.projects.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    isHarness: entry.kind === "harness",
    location: entry.kind === "harness" ? HARNESS_DIRECTORY : entry.repositoryUrl,
  }));
}

export function preparationText(preparation: typeof Preparation.Type): string {
  return preparation.ok
    ? `${preparation.report.stage}: ${preparation.report.reason}`
    : `rejected: ${preparation.problem.code}`;
}

export function diagnosticsText(preparation: typeof Preparation.Type): Option.Option<string> {
  if (preparation.ok || !("diagnostics" in preparation.problem)) return Option.none();

  const { stderrTail, stdoutTail, truncated } = preparation.problem.diagnostics;

  const parts = [
    ...(stderrTail === "" ? [] : [`stderr:\n${stderrTail}`]),
    ...(stdoutTail === "" ? [] : [`stdout:\n${stdoutTail}`]),
    ...(truncated ? ["(output truncated to the last part of each stream)"] : []),
  ];

  return Option.some(parts.join("\n\n"));
}

export function submitRejection({ recorded, error }: SubmissionInterrupted): string {
  const label =
    recorded === undefined
      ? "no label recorded"
      : `label ${recorded.label} recorded (commit ${recorded.harnessCommit})`;

  return `${label}, submit interrupted: error: ${error.code}`;
}
