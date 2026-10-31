import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HARNESS_DIRECTORY } from "../../workspace-layout.js";
import { GitHubReport, type ChatGPTConnection, type Project } from "./model.js";

export function transportDetail(cause: unknown): string {
  return Predicate.isError(cause) ? cause.message : String(cause);
}

export type Wire = Schema.Json | undefined;

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

function isJsonObject(value: Wire): value is Schema.JsonObject {
  return Predicate.isObject(value) && !Array.isArray(value);
}

function isJsonArray(value: Wire): value is Schema.JsonArray {
  return Array.isArray(value);
}

export function field(value: Wire, ...path: readonly string[]): Wire {
  return path.reduce<Wire>(
    (current, key) => (isJsonObject(current) ? current[key] : undefined),
    value,
  );
}

export function text(value: Wire): string {
  return Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
    ? String(value)
    : "";
}

export function isOk(payload: Wire): boolean {
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

function connectionDetail(status: Wire, state: string): string {
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

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function checkedWording(checkedAt: Wire, now: number): string {
  if (!Predicate.isNumber(checkedAt) || !Number.isFinite(checkedAt)) {
    return "";
  }

  const then = new Date(checkedAt);
  const clock = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;

  return then.toDateString() === new Date(now).toDateString()
    ? clock
    : `${then.getFullYear()}-${pad2(then.getMonth() + 1)}-${pad2(then.getDate())} ${clock}`;
}

export function gitHubReport(status: Wire, checkedAt: Wire, now: number): GitHubReport {
  const state = field(status, "state");

  if (!truthy(status) || !Predicate.isString(state)) {
    return GitHubReport.Unknown();
  }

  const isPending = state === "awaiting-authorization";

  return GitHubReport.Known({
    connection: {
      state,
      detail: connectionDetail(status, state),
      verificationUri: isPending ? text(field(status, "verificationUri")) : "",
      checked: isPending ? "" : checkedWording(checkedAt, now),
    },
  });
}

const UNKNOWN_CHATGPT: ChatGPTConnection = {
  connection: "unknown",
  isConnected: false,
  maybeLogin: Option.none(),
};

function chatGPTLogin(login: Wire): ChatGPTConnection["maybeLogin"] {
  const attemptId = text(field(login, "attemptId"));
  const authorizeUrl = text(field(login, "authorizeUrl"));

  return attemptId === "" || authorizeUrl === ""
    ? Option.none()
    : Option.some({ attemptId, authorizeUrl });
}

function usageLimitText(limit: Wire): string {
  const limitedUntil = field(limit, "limitedUntil");

  if (limitedUntil === undefined) {
    return "";
  }

  return Predicate.isNumber(limitedUntil)
    ? `; usage limit reached until ${new Date(limitedUntil).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "; usage limit reached";
}

export function chatGPTConnection(view: Wire): ChatGPTConnection {
  const connection = field(view, "connection");
  const maybeLogin = chatGPTLogin(field(view, "login"));

  switch (text(field(connection, "state"))) {
    case "disconnected":
      return { connection: "not connected (Workers AI fallback)", isConnected: false, maybeLogin };
    case "connected":
      return {
        connection: `connected (${text(field(view, "model"))})${usageLimitText(field(connection, "usageLimit"))}`,
        isConnected: true,
        maybeLogin,
      };
    case "needs-reconnect":
      return {
        connection: `reconnect required: ${text(field(connection, "reason"))}`,
        isConnected: false,
        maybeLogin,
      };
    default:
      return UNKNOWN_CHATGPT;
  }
}

function project(entry: Wire): Project {
  const isHarness = field(entry, "kind") === "harness";

  return {
    id: text(field(entry, "id")),
    displayName: text(field(entry, "displayName")),
    isHarness,
    location: isHarness ? HARNESS_DIRECTORY : text(field(entry, "repositoryUrl")),
  };
}

export function projects(payload: Wire): Option.Option<readonly Project[]> {
  const entries = field(payload, "projects");

  return isOk(payload) && isJsonArray(entries)
    ? Option.some(entries.map((entry) => project(entry)))
    : Option.none();
}

export function preparationText(preparation: Wire): string {
  if (!truthy(preparation)) {
    return "";
  }

  if (field(preparation, "ok") === true) {
    return `${text(field(preparation, "report", "stage"))}: ${text(field(preparation, "report", "reason"))}`;
  }

  return `rejected: ${text(field(preparation, "problem", "code"))}`;
}

export function diagnosticsText(preparation: Wire): Option.Option<string> {
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

export function sendRefusalText(answer: Answer): string {
  switch (text(field(answer.payload, "problem", "code"))) {
    case "no-active-generation":
      return "no active generation: activate one in the generation controls";
    case "workspace-busy":
      return "busy: the workspace is resetting; send again once it finishes";
    default:
      return problemText(answer);
  }
}
