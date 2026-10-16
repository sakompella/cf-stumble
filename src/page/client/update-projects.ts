import * as Array from "effect/Array";
import * as Option from "effect/Option";
import {
  AuthorizeGitHub,
  ConnectRepository,
  DisconnectChatGPT,
  FetchProjects,
  FetchThread,
  FinishChatGPTLogin,
  RefreshGitHub,
  StartChatGPTLogin,
} from "./commands.js";
import type { GitHubReport, Model, Project } from "./model.js";
import { Turn } from "./model.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";

/**
 * The sidebar: what the owner may work in, the GitHub and ChatGPT connections, and connecting
 * another repository. Selecting a project is the only way this page names one, and it is a boundary: it
 * bumps `selection`, so a thread read for the project a reader left is dropped, and it stops any
 * turn still streaming.
 */

function withGitHub(model: Model, report: GitHubReport): Model {
  const github =
    report._tag === "Known"
      ? report.connection
      : {
          state: "unknown",
          detail: "",
          verificationUri: model.github.verificationUri,
          checked: "",
        };

  return { ...model, github };
}

function selectProject(model: Model, project: Project): UpdateReturn {
  const selection = model.selection + 1;

  return {
    model: {
      ...model,
      selection,
      turn: Turn.Idle(),
      maybeProjectId: Option.some(project.id),
      conversationProject: project.displayName,
      isFreshArmed: false,
      turnState: "",
      freshThreadStatus: "",
      transcript: [],
      isAssistantOpen: false,
      conversationState: "reading",
      threadRevision: "",
      threadTurnActive: "",
      threadMessageCount: "",
    },
    commands: [FetchThread({ projectId: project.id, selection, isQuiet: false })],
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
    onNone: () => ({ model: { ...listed, conversationState: "select a project first" } }),
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
        Array.findFirst(model.projects, (project) => project.id === projectId),
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

/**
 * Every ChatGPT answer carries the Worker's whole view of the connection, so the page replaces what
 * it showed instead of working out what the request changed.
 */
const ASKING = "asking ChatGPT";

function asking(model: Model): Model {
  return { ...clearError(model), chatgptResult: ASKING };
}

function finish(model: Model): UpdateReturn {
  return Option.match(model.chatgpt.maybeLogin, {
    onNone: () => ({ model }),
    onSome: (login) => {
      const callbackUrl = model.chatgptCallbackInput.trim();

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
      model: { ...model, chatgptCallbackInput: value },
    }),
    ClickedChatGPTFinish: () => finish(model),
    ClickedChatGPTDisconnect: () => ({ model: asking(model), commands: [DisconnectChatGPT()] }),
    SucceededChatGPT: ({ chatgpt }) => ({
      model: { ...model, chatgpt, chatgptCallbackInput: "", chatgptResult: "" },
    }),
    RejectedChatGPT: ({ wording, maybeChatGPT }) => {
      const chatgpt = Option.getOrElse(maybeChatGPT, () => model.chatgpt);

      return {
        model: {
          ...model,
          chatgpt,
          chatgptCallbackInput: Option.isSome(chatgpt.maybeLogin) ? model.chatgptCallbackInput : "",
          chatgptResult: wording,
        },
      };
    },
    FailedChatGPT: ({ detail }) => ({
      model: {
        ...withError(model, "the ChatGPT request", detail),
        chatgptResult: "request failed",
      },
    }),
  };
}
