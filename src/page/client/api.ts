// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- This module is the parse boundary for the owner API's answers. Nothing a response carries has a proven shape until these readers prove it.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { HARNESS_DIRECTORY } from "../../workspace-layout.js";
import { GitHubReport, type Project, type ThreadFacts } from "./model.js";

/**
 * Requests to this Worker, and the readers that turn an answer into what the page shows. Every
 * path is relative, so every call stays on this origin; the Content Security Policy refuses the
 * rest. The browser sends the Access session cookie it already holds, so the page asks for no
 * credential and stores none.
 */

/** What the page error banner says about a request that never reached the Worker. */
export function transportDetail(error: unknown): string {
  return Predicate.isError(error) ? error.message : String(error);
}

export type JsonBody = Readonly<Record<string, string | number>>;

/**
 * `fetch` as an Effect. Interrupting it aborts the request. `fetch` is read when the request
 * starts, so the page uses whatever `fetch` the document has then; the browser harness replaces
 * it to hold a submission in flight.
 */
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

export type Answer = Readonly<{ status: number; payload: unknown }>;

/** A response read as JSON. A body that is not JSON reads as `null`, as the Worker's 5xx can be. */
export function answerOf(response: Response): Effect.Effect<Answer> {
  return Effect.promise(() =>
    response.json().then(
      (payload: unknown) => payload,
      () => null,
    ),
  ).pipe(Effect.map((payload) => ({ status: response.status, payload })));
}

/** A request whose answer is read as JSON. */
export function requestJson(
  method: "GET" | "POST",
  path: string,
  maybeBody: Option.Option<JsonBody>,
): Effect.Effect<Answer, string> {
  return fetchEffect(path, { method, accept: "application/json", maybeBody }).pipe(
    Effect.flatMap(answerOf),
  );
}

export function projectPath(projectId: string, suffix: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export function field(value: unknown, ...path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (current, key) => (Predicate.hasProperty(current, key) ? current[key] : undefined),
    value,
  );
}

/** A JSON scalar as the page shows it; anything else shows as nothing. */
export function text(value: unknown): string {
  return Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
    ? String(value)
    : "";
}

export function isOk(payload: unknown): boolean {
  return field(payload, "ok") === true;
}

export const truthy = Boolean;

export function problemText(answer: Answer): string {
  const problemCode = field(answer.payload, "problem", "code");

  if (truthy(problemCode)) {
    return `rejected: ${text(problemCode)}`;
  }

  const errorCode = field(answer.payload, "error", "code");

  return truthy(errorCode) ? `error: ${text(errorCode)}` : `error: HTTP ${answer.status}`;
}

function connectionDetail(status: unknown, state: string): string {
  switch (state) {
    case "connected":
      return `${text(field(status, "login"))} (${text(field(status, "source"))})`;
    case "awaiting-authorization":
      return `enter code ${text(field(status, "userCode"))} at GitHub`;
    case "reconnect-required":
      return text(field(status, "reason"));
    case "tooling-missing":
      return "the workspace has no gh command";
    default:
      return "";
  }
}

export function gitHubReport(status: unknown): GitHubReport {
  const state = field(status, "state");

  if (!truthy(status) || !Predicate.isString(state)) {
    return GitHubReport.Unknown();
  }

  return GitHubReport.Known({
    connection: {
      state,
      detail: connectionDetail(status, state),
      verificationUri:
        state === "awaiting-authorization" ? text(field(status, "verificationUri")) : "",
    },
  });
}

function project(entry: unknown): Project {
  const isHarness = field(entry, "kind") === "harness";

  return {
    id: text(field(entry, "id")),
    displayName: text(field(entry, "displayName")),
    isHarness,
    location: isHarness ? HARNESS_DIRECTORY : text(field(entry, "repositoryUrl")),
  };
}

export function projects(payload: unknown): Option.Option<readonly Project[]> {
  const entries = field(payload, "projects");

  return isOk(payload) && Array.isArray(entries)
    ? Option.some(entries.map((entry) => project(entry)))
    : Option.none();
}

export function threadFacts(payload: unknown): Option.Option<ThreadFacts> {
  const thread = field(payload, "thread");

  if (!isOk(payload) || !truthy(thread)) {
    return Option.none();
  }

  const conversation = field(thread, "conversation");

  return Option.some({
    revision: text(field(thread, "revision")),
    turnActive: truthy(field(thread, "turnActive")) ? "yes" : "no",
    messageCount: text(field(thread, "messageCount")),
    conversation: Predicate.isString(conversation) ? conversation : "[]",
  });
}

export function preparationText(preparation: unknown): string {
  if (!truthy(preparation)) {
    return "";
  }

  if (field(preparation, "ok") === true) {
    return `${text(field(preparation, "report", "stage"))}: ${text(field(preparation, "report", "reason"))}`;
  }

  return `rejected: ${text(field(preparation, "problem", "code"))}`;
}

/** The tail of a failed build step. It is untrusted command output, so it is only ever text. */
export function diagnosticsText(preparation: unknown): Option.Option<string> {
  const diagnostics =
    truthy(preparation) && field(preparation, "ok") === false
      ? field(preparation, "problem", "diagnostics")
      : undefined;

  if (!truthy(diagnostics)) {
    return Option.none();
  }

  const stderrTail = field(diagnostics, "stderrTail");
  const stdoutTail = field(diagnostics, "stdoutTail");

  const parts = [
    ...(truthy(stderrTail) ? [`stderr:\n${text(stderrTail)}`] : []),
    ...(truthy(stdoutTail) ? [`stdout:\n${text(stdoutTail)}`] : []),
    ...(field(diagnostics, "truncated") === true
      ? ["(output truncated to the last part of each stream)"]
      : []),
  ];

  return Option.some(parts.join("\n\n"));
}

export function turnRefusalText(answer: Answer): string {
  switch (field(answer.payload, "problem", "code")) {
    case "turn-conflict":
      return "busy: another turn holds this project";
    case "no-active-generation":
      return "no active generation: activate one in the generation controls";
    case "stale-revision":
      return "conflict: this thread moved on; reload the project";
    default:
      return problemText(answer);
  }
}
