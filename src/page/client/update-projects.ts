import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  AuthorizeGitHub,
  ConnectRepository,
  DisconnectChatGPT,
  FetchProjects,
  FinishChatGPTLogin,
  RefreshGitHub,
  StartChatGPTLogin,
} from "./commands.js";
import type { GitHubReport, Model, Project } from "./model.js";
import { keepingAddress, pendingLogin, withAddress } from "./chatgpt.js";
import { StreamPhase } from "./stream-phase.js";
import { withOpenedStream } from "./update-conversation.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";

export { backendHandlers, FetchBackend } from "./update-backend.js";

function withGitHub(model: Model, report: GitHubReport): Model {
  const github = Predicate.isTagged(report, "Known")
    ? report.connection
    : {
        state: "unknown",
        detail: "",
        verificationUri: model.github.verificationUri,
        checked: "",
      };

  return { ...model, github };
}

function withPromptSwitched(model: Model, projectId: string): Model {
  const { [projectId]: incoming = "", ...others } = model.drafts;

  return Option.match(model.maybeProjectId, {
    onNone: () => ({
      ...model,
      drafts: others,
      prompt: model.prompt === "" ? incoming : model.prompt,
    }),
    onSome: (leaving) => ({
      ...model,
      drafts: { ...others, [leaving]: model.prompt },
      prompt: incoming,
    }),
  });
}

function selectProject(model: Model, project: Project): UpdateReturn {
  return {
    model: {
      ...withOpenedStream(withPromptSwitched(model, project.id)),
      maybeProjectId: Option.some(project.id),
      conversationProject: project.displayName,
    },
  };
}

function requestProjects(model: Model): UpdateReturn {
  return {
    model: { ...clearError(model), projectListStatus: "reading" },
    commands: [FetchProjects()],
  };
}

function listedProjects(model: Model, projects: readonly Project[]): UpdateReturn {
  const connected = projects.filter((project) => !project.isHarness).length;

  const listed: Model = {
    ...model,
    projects,
    projectListStatus: connected === 0 ? "no repository connected yet" : `${connected} connected`,
  };

  return Option.match(Array.head(projects), {
    onNone: () => ({ model: { ...listed, streamPhase: StreamPhase.NoProjects() } }),
    onSome: (first) =>
      Option.isNone(model.maybeProjectId) ? selectProject(listed, first) : { model: listed },
  });
}

function connect(model: Model): UpdateReturn {
  const repositoryUrl = model.connectRepositoryInput.trim();

  if (repositoryUrl === "") {
    return { model: { ...clearError(model), connectStatus: "enter a repository url first" } };
  }

  return {
    model: { ...clearError(model), connectStatus: "connecting" },
    commands: [ConnectRepository({ repositoryUrl })],
  };
}

function withMaybeGitHub(model: Model, maybeReport: Option.Option<GitHubReport>): Model {
  return Option.isSome(maybeReport) ? withGitHub(model, maybeReport.value) : model;
}

export function projectHandlers(
  model: Model,
): Handlers<
  | "ClickedSidebarToggle"
  | "ClickedProject"
  | "SucceededFetchProjects"
  | "RejectedFetchProjects"
  | "FailedFetchProjects"
> {
  return {
    ClickedSidebarToggle: () => ({
      model: { ...model, isSidebarExpanded: !model.isSidebarExpanded },
    }),
    ClickedProject: ({ projectId }) =>
      Option.match(
        Array.findFirst(
          model.projects,
          (project) =>
            project.id === projectId && !Option.contains(model.maybeProjectId, projectId),
        ),
        { onNone: () => ({ model }), onSome: (project) => selectProject(model, project) },
      ),
    SucceededFetchProjects: ({ projects }) => listedProjects(model, projects),
    RejectedFetchProjects: ({ wording }) => ({ model: { ...model, projectListStatus: wording } }),
    FailedFetchProjects: ({ detail }) => ({
      model: {
        ...withError(model, "the project list request", detail),
        projectListStatus: "request failed",
      },
    }),
  };
}

export function connectHandlers(
  model: Model,
): Handlers<
  | "UpdatedConnectRepositoryInput"
  | "ClickedConnect"
  | "SucceededConnect"
  | "RejectedConnect"
  | "FailedConnect"
> {
  return {
    UpdatedConnectRepositoryInput: ({ value }) => ({
      model: { ...model, connectRepositoryInput: value },
    }),
    ClickedConnect: () => connect(model),
    SucceededConnect: ({ isAlreadyConnected, maybeGitHub }) =>
      requestProjects({
        ...withMaybeGitHub(model, maybeGitHub),
        connectStatus: isAlreadyConnected ? "already connected" : "connected",
      }),
    RejectedConnect: ({ wording, maybeGitHub }) => ({
      model: { ...withMaybeGitHub(model, maybeGitHub), connectStatus: wording },
    }),
    FailedConnect: ({ detail }) => ({
      model: {
        ...withError(model, "the connect request", detail),
        connectStatus: "request failed",
      },
    }),
  };
}

function askingGitHub(model: Model): Model {
  return { ...clearError(model), github: { ...model.github, detail: "asking GitHub" } };
}

export function gitHubHandlers(
  model: Model,
): Handlers<
  | "ClickedAuthorize"
  | "ClickedRefreshGitHub"
  | "SucceededGitHub"
  | "RejectedGitHub"
  | "FailedGitHub"
> {
  return {
    ClickedAuthorize: ({ path }) => ({
      model: askingGitHub(model),
      commands: [AuthorizeGitHub({ path })],
    }),
    ClickedRefreshGitHub: () => ({ model: askingGitHub(model), commands: [RefreshGitHub()] }),
    SucceededGitHub: ({ github }) => ({ model: withGitHub(model, github) }),
    RejectedGitHub: ({ wording }) => ({
      model: { ...model, github: { ...model.github, state: wording, checked: "" } },
    }),
    FailedGitHub: ({ detail }) => ({
      model: {
        ...withError(model, "the GitHub request", detail),
        github: { ...model.github, state: "request failed", checked: "" },
      },
    }),
  };
}

const ASKING = "asking ChatGPT";

function asking(model: Model): Model {
  return { ...clearError(model), chatgptResult: ASKING };
}

function finish(model: Model): UpdateReturn {
  return Option.match(pendingLogin(model.chatgpt), {
    onNone: () => ({ model }),
    onSome: (login) => {
      const callbackUrl = login.address.trim();

      return callbackUrl === ""
        ? { model: { ...clearError(model), chatgptResult: "paste the address first" } }
        : {
            model: asking(model),
            commands: [FinishChatGPTLogin({ attemptId: login.attemptId, callbackUrl })],
          };
    },
  });
}

export function chatGPTHandlers(
  model: Model,
): Handlers<
  | "ClickedChatGPTLogin"
  | "UpdatedChatGPTCallbackInput"
  | "ClickedChatGPTFinish"
  | "ClickedChatGPTDisconnect"
  | "SucceededChatGPT"
  | "RejectedChatGPT"
  | "FailedChatGPT"
> {
  return {
    ClickedChatGPTLogin: () => ({ model: asking(model), commands: [StartChatGPTLogin()] }),
    UpdatedChatGPTCallbackInput: ({ value }) => ({
      model: { ...model, chatgpt: withAddress(model.chatgpt, value) },
    }),
    ClickedChatGPTFinish: () => finish(model),
    ClickedChatGPTDisconnect: () => ({ model: asking(model), commands: [DisconnectChatGPT()] }),
    SucceededChatGPT: ({ chatgpt }) => ({
      model: { ...model, chatgpt, chatgptResult: "" },
    }),
    RejectedChatGPT: ({ wording, maybeChatGPT }) => {
      const chatgpt = Option.match(maybeChatGPT, {
        onNone: () => model.chatgpt,
        onSome: (next) => keepingAddress(model.chatgpt, next),
      });

      return { model: { ...model, chatgpt, chatgptResult: wording } };
    },
    FailedChatGPT: ({ detail }) => ({
      model: {
        ...withError(model, "the ChatGPT request", detail),
        chatgptResult: "request failed",
      },
    }),
  };
}
