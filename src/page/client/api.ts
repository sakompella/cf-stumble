import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HARNESS_DIRECTORY } from "../../workspace-layout.js";
import { GitHubReport, type GenerationReading, type Project } from "./model.js";

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

const RefusalPayload = Schema.Struct({
  ok: Schema.Literal(false),
  problem: Schema.optional(Schema.Struct({ code: Schema.String })),
  error: Schema.optional(Schema.Struct({ code: Schema.String })),
});

type Refusal = typeof RefusalPayload.Type;

const decodeRefusal = Schema.decodeUnknownOption(RefusalPayload);

export function refusalText(refusal: Refusal, status: number): string {
  const problem = refusal.problem;

  if (problem !== undefined) {
    return `rejected: ${problem.code}`;
  }

  const error = refusal.error;

  return error === undefined ? `error: HTTP ${status}` : `error: ${error.code}`;
}

export function problemText(answer: Answer): string {
  const refusal = Option.getOrUndefined(decodeRefusal(answer.payload));

  return refusal === undefined
    ? `error: HTTP ${answer.status}`
    : refusalText(refusal, answer.status);
}

export type Answered<A> = Readonly<{
  status: number;
  maybeAnswer: Option.Option<A>;
  maybeRefusal: Option.Option<Refusal>;
}>;

export function requestJson<S extends Schema.ConstraintDecoder<unknown>>(
  method: "GET" | "POST",
  path: string,
  maybeBody: Option.Option<JsonBody>,
  schema: S,
): Effect.Effect<Answered<S["Type"]>, string> {
  return fetchEffect(path, { method, accept: "application/json", maybeBody }).pipe(
    Effect.flatMap(answerOf),
    Effect.map(({ status, payload }) => {
      const maybeAnswer = Schema.decodeUnknownOption(schema)(payload);

      return {
        status,
        maybeAnswer,
        maybeRefusal: Option.isNone(maybeAnswer) ? decodeRefusal(payload) : Option.none(),
      };
    }),
  );
}

export function refusalWording(
  answered: Readonly<Pick<Answered<unknown>, "status" | "maybeRefusal">>,
): string {
  return Option.match(answered.maybeRefusal, {
    onNone: () => `error: HTTP ${answered.status}`,
    onSome: (refusal) => refusalText(refusal, answered.status),
  });
}

export function sendRefusalText(
  answered: Readonly<Pick<Answered<unknown>, "status" | "maybeRefusal">>,
): string {
  const refusal = Option.getOrUndefined(answered.maybeRefusal);
  const code = refusal?.problem?.code;

  if (code === "no-active-generation") {
    return "no active generation: activate one in the generation controls";
  }

  if (code === "workspace-busy") {
    return "busy: the workspace is resetting; send again once it finishes";
  }

  return refusal === undefined
    ? `error: HTTP ${answered.status}`
    : refusalText(refusal, answered.status);
}

const GenerationView = Schema.Struct({
  label: Schema.Number,
  harnessCommit: Schema.String,
  status: Schema.String,
});

export const StatusAnswer = Schema.Struct({
  activeGeneration: Schema.Struct({
    generation: Schema.NullOr(GenerationView),
    epoch: Schema.Number,
  }),
  mainAhead: Schema.NullOr(Schema.Number),
});

export type StatusAnswer = typeof StatusAnswer.Type;

export const decodeStatusAnswer = Schema.decodeUnknownOption(StatusAnswer);

export function generationReading(answer: StatusAnswer): GenerationReading {
  const { generation, epoch } = answer.activeGeneration;

  return {
    epoch,
    maybeActive: generation === null ? Option.none() : Option.some(generation),
    maybeMainAhead: Option.fromNullishOr(answer.mainAhead),
  };
}

export const GitHubStatus = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ state: Schema.Literal("disconnected") }),
    Schema.Struct({ state: Schema.Literal("tooling-missing") }),
    Schema.Struct({
      state: Schema.Literal("connected"),
      login: Schema.String,
      source: Schema.String,
    }),
    Schema.Struct({ state: Schema.Literal("reconnect-required"), reason: Schema.String }),
    Schema.Struct({
      state: Schema.Literal("awaiting-authorization"),
      verificationUri: Schema.String,
      userCode: Schema.String,
      expiresAt: Schema.Number,
    }),
  ]),
);

export type GitHubStatusView = typeof GitHubStatus.Type;

function connectionDetail(status: Exclude<GitHubStatusView, null>): string {
  if (status.state === "connected") {
    return `${status.login} (${status.source})`;
  }

  if (status.state === "awaiting-authorization") {
    return `enter code ${status.userCode} at GitHub`;
  }

  if (status.state === "reconnect-required") {
    return status.reason;
  }

  if (status.state === "tooling-missing") {
    return "the workspace has no gh command";
  }

  return "";
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

export function gitHubReport(
  status: GitHubStatusView,
  checkedAt: number | null,
  now: number,
): GitHubReport {
  if (status === null) return GitHubReport.Unknown();

  const isPending = status.state === "awaiting-authorization";

  return GitHubReport.Known({
    connection: {
      state: status.state,
      detail: connectionDetail(status),
      verificationUri: isPending ? status.verificationUri : "",
      checked: isPending ? "" : checkedWording(checkedAt, now),
    },
  });
}

const ProjectEntry = Schema.Struct({
  kind: Schema.Literals(["harness", "repository"]),
  id: Schema.String,
  displayName: Schema.String,
  repositoryUrl: Schema.optional(Schema.String),
});

export const ProjectsAnswer = Schema.Struct({
  ok: Schema.Literal(true),
  projects: Schema.Array(ProjectEntry),
});

export function projectsOf(answer: typeof ProjectsAnswer.Type): readonly Project[] {
  return answer.projects.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    isHarness: entry.kind === "harness",
    location: entry.kind === "harness" ? HARNESS_DIRECTORY : (entry.repositoryUrl ?? ""),
  }));
}

const PreparationDiagnostics = Schema.Struct({
  stderrTail: Schema.optional(Schema.String),
  stdoutTail: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
});

const PreparationProblem = Schema.Struct({
  code: Schema.String,
  diagnostics: Schema.optional(PreparationDiagnostics),
});

export const Preparation = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    report: Schema.Struct({ stage: Schema.String, reason: Schema.optional(Schema.String) }),
  }),
  Schema.Struct({ ok: Schema.Literal(false), problem: PreparationProblem }),
]);

export type Preparation = typeof Preparation.Type;

export function preparationText(preparation: Preparation): string {
  return preparation.ok
    ? `${preparation.report.stage}: ${preparation.report.reason ?? ""}`
    : `rejected: ${preparation.problem.code}`;
}

export function diagnosticsText(preparation: Preparation): Option.Option<string> {
  if (preparation.ok) return Option.none();

  const diagnostics = preparation.problem.diagnostics;

  if (diagnostics === undefined) return Option.none();

  const parts = [
    ...(diagnostics.stderrTail !== undefined && diagnostics.stderrTail !== ""
      ? [`stderr:\n${diagnostics.stderrTail}`]
      : []),
    ...(diagnostics.stdoutTail !== undefined && diagnostics.stdoutTail !== ""
      ? [`stdout:\n${diagnostics.stdoutTail}`]
      : []),
    ...(diagnostics.truncated === true
      ? ["(output truncated to the last part of each stream)"]
      : []),
  ];

  return Option.some(parts.join("\n\n"));
}

export const SubmitRefusal = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.String }),
  recorded: Schema.optional(Schema.Struct({ label: Schema.Number, harnessCommit: Schema.String })),
});

export type SubmitRefusal = typeof SubmitRefusal.Type;

export function submitRejection(refusal: SubmitRefusal): string {
  const recorded = refusal.recorded;

  return recorded === undefined
    ? `error: ${refusal.error.code}`
    : `label ${recorded.label} recorded (commit ${recorded.harnessCommit}), preparation failed: error: ${refusal.error.code}`;
}

export function projectPath(projectId: string, suffix: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}
