import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "foldkit";
import * as Schema from "effect/Schema";
import {
  ConnectAnswer,
  GitHubAnswer,
  OkAnswer,
  RunControlAnswer,
  SubmitAnswer,
} from "./answers.js";
import {
  diagnosticsText,
  generationReading,
  gitHubReport,
  preparationText,
  projectPath,
  projectsOf,
  ProjectsAnswer,
  refusalWording,
  requestJson,
  sendRefusalText,
  StatusAnswer,
  submitRejection,
} from "./api.js";
import { Message } from "./message.js";
import { ControlKind } from "./model.js";
import { SentMessage } from "./sent-message.js";

export { FetchChatGPT } from "./commands-chatgpt.js";

export const FetchStatus = Command.define("FetchStatus", {
  messages: [Message.SucceededFetchStatus, Message.RejectedFetchStatus, Message.FailedFetchStatus],
  execute: requestJson("GET", "/api/status", Option.none(), StatusAnswer).pipe(
    Effect.map((answered) =>
      Option.match(answered.maybeAnswer, {
        onNone: () => Message.RejectedFetchStatus({ wording: refusalWording(answered) }),
        onSome: (answer) => Message.SucceededFetchStatus({ reading: generationReading(answer) }),
      }),
    ),
    Effect.catch((detail) => Effect.succeed(Message.FailedFetchStatus({ detail }))),
  ),
});

export const FetchProjects = Command.define("FetchProjects", {
  messages: [
    Message.SucceededFetchProjects,
    Message.RejectedFetchProjects,
    Message.FailedFetchProjects,
  ],
  execute: requestJson("GET", "/api/projects", Option.none(), ProjectsAnswer).pipe(
    Effect.map((answered) =>
      Option.match(answered.maybeAnswer, {
        onNone: () => Message.RejectedFetchProjects({ wording: refusalWording(answered) }),
        onSome: (answer) => Message.SucceededFetchProjects({ projects: projectsOf(answer) }),
      }),
    ),
    Effect.catch((detail) => Effect.succeed(Message.FailedFetchProjects({ detail }))),
  ),
});

export const ConnectRepository = Command.define("ConnectRepository", {
  args: { repositoryUrl: Schema.String },
  messages: [Message.SucceededConnect, Message.RejectedConnect, Message.FailedConnect],
  execute: ({ repositoryUrl }) =>
    requestJson(
      "POST",
      "/api/projects/connect",
      Option.some({ repositoryUrl }),
      ConnectAnswer,
    ).pipe(
      Effect.map((answered) =>
        Option.match(answered.maybeAnswer, {
          onNone: () =>
            Message.RejectedConnect({
              wording: refusalWording(answered),
              maybeGitHub: Option.none(),
            }),
          onSome: (answer) =>
            answer.ok
              ? Message.SucceededConnect({
                  isAlreadyConnected: answer.alreadyConnected,
                  maybeGitHub: Option.some(
                    gitHubReport(answer.github, answer.checkedAt, Date.now()),
                  ),
                })
              : Message.RejectedConnect({
                  wording: `rejected: ${answer.problem.code}`,
                  maybeGitHub: Option.some(
                    gitHubReport(answer.github ?? null, answer.checkedAt ?? null, Date.now()),
                  ),
                }),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedConnect({ detail }))),
    ),
});

const GITHUB_MESSAGES = [
  Message.SucceededGitHub,
  Message.RejectedGitHub,
  Message.FailedGitHub,
] as const;

function gitHubRequest(method: "GET" | "POST", path: string) {
  return requestJson(
    method,
    path,
    method === "POST" ? Option.some({}) : Option.none(),
    GitHubAnswer,
  ).pipe(
    Effect.map((answered) =>
      Option.match(answered.maybeAnswer, {
        onNone: () => Message.RejectedGitHub({ wording: refusalWording(answered) }),
        onSome: (answer) =>
          answer.ok
            ? Message.SucceededGitHub({
                github: gitHubReport(answer.github, answer.checkedAt, Date.now()),
              })
            : Message.RejectedGitHub({ wording: `rejected: ${answer.problem.code}` }),
      }),
    ),
    Effect.catch((detail) => Effect.succeed(Message.FailedGitHub({ detail }))),
  );
}

export const AuthorizeGitHub = Command.define("AuthorizeGitHub", {
  args: { path: Schema.String },
  messages: GITHUB_MESSAGES,
  execute: ({ path }) => gitHubRequest("POST", path),
});

export const FetchGitHub = Command.define("FetchGitHub", {
  messages: GITHUB_MESSAGES,
  execute: gitHubRequest("GET", "/api/github/connection"),
});

export const RefreshGitHub = Command.define("RefreshGitHub", {
  messages: GITHUB_MESSAGES,
  execute: gitHubRequest("POST", "/api/github/connection/refresh"),
});

export const MintRequestId = Command.define("MintRequestId", {
  args: { projectId: Schema.String, content: Schema.String },
  messages: [Message.MintedRequestId],
  execute: ({ projectId, content }) =>
    Effect.sync(() =>
      Message.MintedRequestId({ projectId, content, requestId: globalThis.crypto.randomUUID() }),
    ),
});

export const SendMessage = Command.define("SendMessage", {
  args: {
    projectId: Schema.String,
    requestId: Schema.String,
    content: Schema.String,
    budgetMinutes: Schema.Number,
  },
  messages: [Message.SucceededSend, Message.RejectedSend, Message.FailedSend],
  execute: ({ projectId, requestId, content, budgetMinutes }) =>
    requestJson(
      "POST",
      projectPath(projectId, "/messages"),
      Option.some({ content, requestId, budgetMinutes }),
      SentMessage,
    ).pipe(
      Effect.map((answered) =>
        Option.match(answered.maybeAnswer, {
          onSome: ({ submissionId }) => Message.SucceededSend({ requestId, submissionId }),
          onNone: () =>
            answered.status >= 500
              ? Message.FailedSend({ requestId, detail: sendRefusalText(answered) })
              : Message.RejectedSend({ requestId, wording: sendRefusalText(answered) }),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedSend({ requestId, detail }))),
    ),
});

export const AbortRun = Command.define("AbortRun", {
  args: { projectId: Schema.String },
  messages: [Message.SucceededAbort, Message.RejectedAbort, Message.FailedAbort],
  execute: ({ projectId }) =>
    requestJson("POST", projectPath(projectId, "/abort"), Option.none(), OkAnswer).pipe(
      Effect.map((answered) =>
        Option.match(answered.maybeAnswer, {
          onNone: () => Message.RejectedAbort({ wording: refusalWording(answered) }),
          onSome: () => Message.SucceededAbort(),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedAbort({ detail }))),
    ),
});

export const ReplaceThread = Command.define("ReplaceThread", {
  args: { projectId: Schema.String, streamId: Schema.Number },
  messages: [Message.SucceededFreshThread, Message.RejectedFreshThread, Message.FailedFreshThread],
  execute: ({ projectId, streamId }) =>
    requestJson("POST", projectPath(projectId, "/thread/fresh"), Option.none(), OkAnswer).pipe(
      Effect.map((answered) =>
        Option.match(answered.maybeAnswer, {
          onNone: () =>
            Message.RejectedFreshThread({ streamId, wording: refusalWording(answered) }),
          onSome: () => Message.SucceededFreshThread({ streamId }),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedFreshThread({ streamId, detail }))),
    ),
});

export const SubmitCandidate = Command.define("SubmitCandidate", {
  args: { harnessCommit: Schema.String },
  messages: [Message.SucceededSubmit, Message.RejectedSubmit, Message.FailedSubmit],
  execute: ({ harnessCommit }) =>
    requestJson(
      "POST",
      "/api/generations/submit",
      Option.some({ harnessCommit }),
      SubmitAnswer,
    ).pipe(
      Effect.map((answered) =>
        Option.match(answered.maybeAnswer, {
          onNone: () => Message.RejectedSubmit({ wording: refusalWording(answered) }),
          onSome: (answer) =>
            answer.ok
              ? Message.SucceededSubmit({
                  label: answer.outcome.generation.label,
                  epoch: answer.outcome.epoch,
                  preparation: preparationText(answer.preparation),
                  maybeDiagnostics: diagnosticsText(answer.preparation),
                })
              : Message.RejectedSubmit({ wording: submitRejection(answer) }),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedSubmit({ detail }))),
    ),
});

export const RunControl = Command.define("RunControl", {
  args: { kind: ControlKind, observedEpoch: Schema.Number, label: Schema.Number },
  messages: [Message.SucceededControl, Message.RejectedControl, Message.FailedControl],
  execute: ({ kind, observedEpoch, label }) =>
    requestJson(
      "POST",
      `/api/generations/${kind}`,
      Option.some({ observedEpoch, label }),
      RunControlAnswer,
    ).pipe(
      Effect.map((answered) =>
        Option.match(answered.maybeAnswer, {
          onNone: () =>
            Message.RejectedControl({
              kind,
              sentEpoch: observedEpoch,
              wording: refusalWording(answered),
            }),
          onSome: (answer) =>
            answer.ok
              ? Message.SucceededControl({
                  kind,
                  sentEpoch: observedEpoch,
                  effect: answer.outcome.effect,
                })
              : Message.RejectedControl({
                  kind,
                  sentEpoch: observedEpoch,
                  wording: `rejected: ${answer.problem.code}`,
                }),
        }),
      ),
      Effect.catch((detail) =>
        Effect.succeed(Message.FailedControl({ kind, sentEpoch: observedEpoch, detail })),
      ),
    ),
});
