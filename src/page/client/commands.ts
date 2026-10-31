import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "foldkit";
import * as Schema from "effect/Schema";
import {
  type Answer,
  type JsonBody,
  chatGPTConnection,
  diagnosticsText,
  field,
  generationReading,
  gitHubReport,
  isOk,
  numberField,
  preparationText,
  problemText,
  projectPath,
  projects,
  requestJson,
  sendRefusalText,
  text,
  truthy,
} from "./api.js";
import { Message } from "./message.js";
import { ControlKind } from "./model.js";
import { sentMessage } from "./sent-message.js";

export const FetchStatus = Command.define("FetchStatus", {
  messages: [Message.SucceededFetchStatus, Message.RejectedFetchStatus, Message.FailedFetchStatus],
  execute: requestJson("GET", "/api/status", Option.none()).pipe(
    Effect.map((answer) =>
      Option.match(generationReading(answer.payload), {
        onNone: () => Message.RejectedFetchStatus({ wording: problemText(answer) }),
        onSome: (reading) => Message.SucceededFetchStatus({ reading }),
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
  execute: requestJson("GET", "/api/projects", Option.none()).pipe(
    Effect.map((answer) =>
      Option.match(projects(answer.payload), {
        onNone: () => Message.RejectedFetchProjects({ wording: problemText(answer) }),
        onSome: (list) => Message.SucceededFetchProjects({ projects: list }),
      }),
    ),
    Effect.catch((detail) => Effect.succeed(Message.FailedFetchProjects({ detail }))),
  ),
});

export const ConnectRepository = Command.define("ConnectRepository", {
  args: { repositoryUrl: Schema.String },
  messages: [Message.SucceededConnect, Message.RejectedConnect, Message.FailedConnect],
  execute: ({ repositoryUrl }) =>
    requestJson("POST", "/api/projects/connect", Option.some({ repositoryUrl })).pipe(
      Effect.map((answer) => {
        const github = field(answer.payload, "github");

        const maybeGitHub = truthy(github)
          ? Option.some(gitHubReport(github, field(answer.payload, "checkedAt"), Date.now()))
          : Option.none();

        return isOk(answer.payload)
          ? Message.SucceededConnect({
              isAlreadyConnected: Boolean(field(answer.payload, "alreadyConnected")),
              maybeGitHub,
            })
          : Message.RejectedConnect({ wording: problemText(answer), maybeGitHub });
      }),
      Effect.catch((detail) => Effect.succeed(Message.FailedConnect({ detail }))),
    ),
});

const GITHUB_MESSAGES = [
  Message.SucceededGitHub,
  Message.RejectedGitHub,
  Message.FailedGitHub,
] as const;

function gitHubRequest(method: "GET" | "POST", path: string) {
  return requestJson(method, path, method === "POST" ? Option.some({}) : Option.none()).pipe(
    Effect.map((answer) =>
      isOk(answer.payload)
        ? Message.SucceededGitHub({
            github: gitHubReport(
              field(answer.payload, "github"),
              field(answer.payload, "checkedAt"),
              Date.now(),
            ),
          })
        : Message.RejectedGitHub({ wording: problemText(answer) }),
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

type ChatGPTAnswer = Extract<Message, { readonly _tag: "SucceededChatGPT" | "RejectedChatGPT" }>;

function chatGPTAnswer(answer: Answer): ChatGPTAnswer {
  const chatgpt = field(answer.payload, "chatgpt");

  return isOk(answer.payload)
    ? Message.SucceededChatGPT({ chatgpt: chatGPTConnection(chatgpt) })
    : Message.RejectedChatGPT({
        wording: problemText(answer),
        maybeChatGPT: truthy(chatgpt) ? Option.some(chatGPTConnection(chatgpt)) : Option.none(),
      });
}

const CHATGPT_MESSAGES = [
  Message.SucceededChatGPT,
  Message.RejectedChatGPT,
  Message.FailedChatGPT,
] as const;

function chatGPTRequest(method: "GET" | "POST", path: string, maybeBody: Option.Option<JsonBody>) {
  return requestJson(method, path, maybeBody).pipe(
    Effect.map(chatGPTAnswer),
    Effect.catch((detail) => Effect.succeed(Message.FailedChatGPT({ detail }))),
  );
}

export const FetchChatGPT = Command.define("FetchChatGPT", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("GET", "/api/chatgpt/connection", Option.none()),
});

export const StartChatGPTLogin = Command.define("StartChatGPTLogin", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("POST", "/api/chatgpt/login", Option.some({})),
});

export const FinishChatGPTLogin = Command.define("FinishChatGPTLogin", {
  args: { attemptId: Schema.String, callbackUrl: Schema.String },
  messages: CHATGPT_MESSAGES,
  execute: ({ attemptId, callbackUrl }) =>
    chatGPTRequest("POST", "/api/chatgpt/login/complete", Option.some({ attemptId, callbackUrl })),
});

export const DisconnectChatGPT = Command.define("DisconnectChatGPT", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("POST", "/api/chatgpt/disconnect", Option.some({})),
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
  args: { projectId: Schema.String, requestId: Schema.String, content: Schema.String },
  messages: [Message.SucceededSend, Message.RejectedSend, Message.FailedSend],
  execute: ({ projectId, requestId, content }) =>
    requestJson(
      "POST",
      projectPath(projectId, "/messages"),
      Option.some({ content, requestId }),
    ).pipe(
      Effect.map((answer) =>
        Option.match(sentMessage(answer.payload), {
          onSome: ({ submissionId }) => Message.SucceededSend({ requestId, submissionId }),
          onNone: () => Message.RejectedSend({ requestId, wording: sendRefusalText(answer) }),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedSend({ requestId, detail }))),
    ),
});

export const AbortRun = Command.define("AbortRun", {
  args: { projectId: Schema.String },
  messages: [Message.SucceededAbort, Message.RejectedAbort, Message.FailedAbort],
  execute: ({ projectId }) =>
    requestJson("POST", projectPath(projectId, "/abort"), Option.none()).pipe(
      Effect.map((answer) =>
        isOk(answer.payload)
          ? Message.SucceededAbort()
          : Message.RejectedAbort({ wording: problemText(answer) }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedAbort({ detail }))),
    ),
});

export const ReplaceThread = Command.define("ReplaceThread", {
  args: { projectId: Schema.String, streamId: Schema.Number },
  messages: [Message.SucceededFreshThread, Message.RejectedFreshThread, Message.FailedFreshThread],
  execute: ({ projectId, streamId }) =>
    requestJson("POST", projectPath(projectId, "/thread/fresh"), Option.none()).pipe(
      Effect.map((answer) =>
        isOk(answer.payload)
          ? Message.SucceededFreshThread({ streamId })
          : Message.RejectedFreshThread({ streamId, wording: problemText(answer) }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedFreshThread({ streamId, detail }))),
    ),
});

export const SubmitCandidate = Command.define("SubmitCandidate", {
  args: { harnessCommit: Schema.String },
  messages: [Message.SucceededSubmit, Message.RejectedSubmit, Message.FailedSubmit],
  execute: ({ harnessCommit }) =>
    requestJson("POST", "/api/generations/submit", Option.some({ harnessCommit })).pipe(
      Effect.map((answer) => {
        const preparation = field(answer.payload, "preparation");

        const maybeOutcome = Option.all({
          label: numberField(answer.payload, "outcome", "generation", "label"),
          epoch: numberField(answer.payload, "outcome", "epoch"),
        });

        return isOk(answer.payload) && Option.isSome(maybeOutcome)
          ? Message.SucceededSubmit({
              ...maybeOutcome.value,
              preparation: preparationText(preparation),
              maybeDiagnostics: diagnosticsText(preparation),
            })
          : Message.RejectedSubmit({ wording: problemText(answer) });
      }),
      Effect.catch((detail) => Effect.succeed(Message.FailedSubmit({ detail }))),
    ),
});

export const RunControl = Command.define("RunControl", {
  args: { kind: ControlKind, observedEpoch: Schema.Number, label: Schema.Number },
  messages: [Message.SucceededControl, Message.RejectedControl, Message.FailedControl],
  execute: ({ kind, observedEpoch, label }) =>
    requestJson("POST", `/api/generations/${kind}`, Option.some({ observedEpoch, label })).pipe(
      Effect.map((answer) =>
        isOk(answer.payload)
          ? Message.SucceededControl({
              kind,
              sentEpoch: observedEpoch,
              effect: text(field(answer.payload, "outcome", "effect")),
            })
          : Message.RejectedControl({
              kind,
              sentEpoch: observedEpoch,
              wording: problemText(answer),
            }),
      ),
      Effect.catch((detail) =>
        Effect.succeed(Message.FailedControl({ kind, sentEpoch: observedEpoch, detail })),
      ),
    ),
});
