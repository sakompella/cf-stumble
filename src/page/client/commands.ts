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
  gitHubReport,
  isOk,
  preparationText,
  problemText,
  projectPath,
  projects,
  requestJson,
  text,
  threadFacts,
  truthy,
} from "./api.js";
import { Message } from "./message.js";
import { ControlKind } from "./model.js";

/**
 * Every request the page makes, as a Command. Each one turns its answer into exactly one of its
 * declared Messages, so a refused or unreachable request is a fact update handles rather than an
 * exception that escapes.
 */

export const FetchStatus = Command.define("FetchStatus", {
  messages: [Message.SucceededFetchStatus, Message.RejectedFetchStatus, Message.FailedFetchStatus],
  execute: requestJson("GET", "/api/status", Option.none()).pipe(
    Effect.map((answer) => {
      const active = field(answer.payload, "activeGeneration");

      if (!truthy(active)) {
        return Message.RejectedFetchStatus({ wording: problemText(answer) });
      }

      const generation = field(active, "generation");
      const isPresent = truthy(generation);

      return Message.SucceededFetchStatus({
        label: isPresent ? text(field(generation, "label")) : "none",
        commit: isPresent ? text(field(generation, "harnessCommit")) : "none",
        status: isPresent ? text(field(generation, "status")) : "none active",
        epoch: text(field(active, "epoch")),
      });
    }),
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
        onSome: (list) =>
          Message.SucceededFetchProjects({
            projects: list,
            github: gitHubReport(field(answer.payload, "github")),
          }),
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
        const maybeGitHub = truthy(github) ? Option.some(gitHubReport(github)) : Option.none();

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

export const AuthorizeGitHub = Command.define("AuthorizeGitHub", {
  args: { path: Schema.String },
  messages: [Message.SucceededAuthorize, Message.RejectedAuthorize, Message.FailedAuthorize],
  execute: ({ path }) =>
    requestJson("POST", path, Option.some({})).pipe(
      Effect.map((answer) =>
        isOk(answer.payload)
          ? Message.SucceededAuthorize({ github: gitHubReport(field(answer.payload, "github")) })
          : Message.RejectedAuthorize({ wording: problemText(answer) }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedAuthorize({ detail }))),
    ),
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

export const FetchThread = Command.define("FetchThread", {
  args: { projectId: Schema.String, selection: Schema.Number, isQuiet: Schema.Boolean },
  messages: [Message.SucceededFetchThread, Message.RejectedFetchThread, Message.FailedFetchThread],
  execute: ({ projectId, selection, isQuiet }) =>
    requestJson("GET", projectPath(projectId, "/thread"), Option.none()).pipe(
      Effect.map((answer) =>
        Option.match(threadFacts(answer.payload), {
          onNone: () => Message.RejectedFetchThread({ selection, wording: problemText(answer) }),
          onSome: (thread) => Message.SucceededFetchThread({ selection, isQuiet, thread }),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedFetchThread({ selection, detail }))),
    ),
});

export const ReplaceThread = Command.define("ReplaceThread", {
  args: { projectId: Schema.String, selection: Schema.Number },
  messages: [Message.SucceededFreshThread, Message.RejectedFreshThread, Message.FailedFreshThread],
  execute: ({ projectId, selection }) =>
    requestJson("POST", projectPath(projectId, "/thread/fresh"), Option.none()).pipe(
      Effect.map((answer) =>
        Option.match(threadFacts(answer.payload), {
          onNone: () => Message.RejectedFreshThread({ selection, wording: problemText(answer) }),
          onSome: (thread) => Message.SucceededFreshThread({ selection, thread }),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedFreshThread({ selection, detail }))),
    ),
});

export const SubmitCandidate = Command.define("SubmitCandidate", {
  args: { harnessCommit: Schema.String },
  messages: [Message.SucceededSubmit, Message.RejectedSubmit, Message.FailedSubmit],
  execute: ({ harnessCommit }) =>
    requestJson("POST", "/api/generations/submit", Option.some({ harnessCommit })).pipe(
      Effect.map((answer) => {
        if (!isOk(answer.payload)) {
          return Message.RejectedSubmit({ wording: problemText(answer) });
        }

        const preparation = field(answer.payload, "preparation");

        return Message.SucceededSubmit({
          label: text(field(answer.payload, "outcome", "generation", "label")),
          epoch: text(field(answer.payload, "outcome", "epoch")),
          preparation: preparationText(preparation),
          maybeDiagnostics: diagnosticsText(preparation),
        });
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
              effect: text(field(answer.payload, "outcome", "effect")),
            })
          : Message.RejectedControl({ kind, wording: problemText(answer) }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedControl({ kind, detail }))),
    ),
});
