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
  StatusAnswer,
  submitRejection,
} from "./api.js";
import { Message } from "./message.js";
import { ControlKind } from "./model.js";
import { ownerRequest, rejectedAs } from "./owner-request.js";

export { FetchChatGPT } from "./commands-chatgpt.js";

export { MintRequestId, SendMessage } from "./commands-send.js";

export const FetchStatus = Command.define("FetchStatus", {
  messages: [Message.SucceededFetchStatus, Message.RejectedFetchStatus, Message.FailedFetchStatus],
  execute: ownerRequest(
    { method: "GET", path: "/api/status", maybeBody: Option.none(), answer: StatusAnswer },
    {
      answered: (answer) => Message.SucceededFetchStatus({ reading: generationReading(answer) }),
      ...rejectedAs((wording) => Message.RejectedFetchStatus({ wording })),
      failed: (detail) => Message.FailedFetchStatus({ detail }),
    },
  ),
});

export const FetchProjects = Command.define("FetchProjects", {
  messages: [
    Message.SucceededFetchProjects,
    Message.RejectedFetchProjects,
    Message.FailedFetchProjects,
  ],
  execute: ownerRequest(
    { method: "GET", path: "/api/projects", maybeBody: Option.none(), answer: ProjectsAnswer },
    {
      answered: (answer) => Message.SucceededFetchProjects({ projects: projectsOf(answer) }),
      ...rejectedAs((wording) => Message.RejectedFetchProjects({ wording })),
      failed: (detail) => Message.FailedFetchProjects({ detail }),
    },
  ),
});

export const ConnectRepository = Command.define("ConnectRepository", {
  args: { repositoryUrl: Schema.String },
  messages: [Message.SucceededConnect, Message.RejectedConnect, Message.FailedConnect],
  execute: ({ repositoryUrl }) =>
    ownerRequest(
      {
        method: "POST",
        path: "/api/projects/connect",
        maybeBody: Option.some({ repositoryUrl }),
        answer: ConnectAnswer,
      },
      {
        answered: (answer, now) =>
          answer.ok
            ? Message.SucceededConnect({
                isAlreadyConnected: answer.alreadyConnected,
                maybeGitHub: Option.some(gitHubReport(answer.github, answer.checkedAt, now)),
              })
            : Message.RejectedConnect({
                wording: `rejected: ${answer.problem.code}`,
                maybeGitHub: Option.some(
                  gitHubReport(answer.github ?? null, answer.checkedAt ?? null, now),
                ),
              }),
        ...rejectedAs((wording) =>
          Message.RejectedConnect({ wording, maybeGitHub: Option.none() }),
        ),
        failed: (detail) => Message.FailedConnect({ detail }),
      },
    ),
});

const GITHUB_MESSAGES = [
  Message.SucceededGitHub,
  Message.RejectedGitHub,
  Message.FailedGitHub,
] as const;

function gitHubRequest(method: "GET" | "POST", path: string) {
  return ownerRequest(
    {
      method,
      path,
      maybeBody: method === "POST" ? Option.some({}) : Option.none(),
      answer: GitHubAnswer,
    },
    {
      answered: (answer, now) =>
        answer.ok
          ? Message.SucceededGitHub({
              github: gitHubReport(answer.github, answer.checkedAt, now),
            })
          : Message.RejectedGitHub({ wording: `rejected: ${answer.problem.code}` }),
      ...rejectedAs((wording) => Message.RejectedGitHub({ wording })),
      failed: (detail) => Message.FailedGitHub({ detail }),
    },
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

export const AbortRun = Command.define("AbortRun", {
  args: { projectId: Schema.String },
  messages: [Message.SucceededAbort, Message.RejectedAbort, Message.FailedAbort],
  execute: ({ projectId }) =>
    ownerRequest(
      {
        method: "POST",
        path: projectPath(projectId, "/abort"),
        maybeBody: Option.none(),
        answer: OkAnswer,
      },
      {
        answered: () => Message.SucceededAbort(),
        ...rejectedAs((wording) => Message.RejectedAbort({ wording })),
        failed: (detail) => Message.FailedAbort({ detail }),
      },
    ),
});

export const ReplaceThread = Command.define("ReplaceThread", {
  args: { projectId: Schema.String, streamId: Schema.Number },
  messages: [Message.SucceededFreshThread, Message.RejectedFreshThread, Message.FailedFreshThread],
  execute: ({ projectId, streamId }) =>
    ownerRequest(
      {
        method: "POST",
        path: projectPath(projectId, "/thread/fresh"),
        maybeBody: Option.none(),
        answer: OkAnswer,
      },
      {
        answered: () => Message.SucceededFreshThread({ streamId }),
        ...rejectedAs((wording) => Message.RejectedFreshThread({ streamId, wording })),
        failed: (detail) => Message.FailedFreshThread({ streamId, detail }),
      },
    ),
});

export const SubmitCandidate = Command.define("SubmitCandidate", {
  args: { harnessCommit: Schema.String },
  messages: [Message.SucceededSubmit, Message.RejectedSubmit, Message.FailedSubmit],
  execute: ({ harnessCommit }) =>
    ownerRequest(
      {
        method: "POST",
        path: "/api/generations/submit",
        maybeBody: Option.some({ harnessCommit }),
        answer: SubmitAnswer,
      },
      {
        answered: (answer) =>
          answer.ok
            ? Message.SucceededSubmit({
                label: answer.outcome.generation.label,
                epoch: answer.outcome.epoch,
                preparation: preparationText(answer.preparation),
                maybeDiagnostics: diagnosticsText(answer.preparation),
              })
            : Message.RejectedSubmit({ wording: submitRejection(answer) }),
        ...rejectedAs((wording) => Message.RejectedSubmit({ wording })),
        failed: (detail) => Message.FailedSubmit({ detail }),
      },
    ),
});

export const RunControl = Command.define("RunControl", {
  args: { kind: ControlKind, observedEpoch: Schema.Number, label: Schema.Number },
  messages: [Message.SucceededControl, Message.RejectedControl, Message.FailedControl],
  execute: ({ kind, observedEpoch, label }) =>
    ownerRequest(
      {
        method: "POST",
        path: `/api/generations/${kind}`,
        maybeBody: Option.some({ observedEpoch, label }),
        answer: RunControlAnswer,
      },
      {
        answered: (answer) =>
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
        ...rejectedAs((wording) =>
          Message.RejectedControl({ kind, sentEpoch: observedEpoch, wording }),
        ),
        failed: (detail) => Message.FailedControl({ kind, sentEpoch: observedEpoch, detail }),
      },
    ),
});
