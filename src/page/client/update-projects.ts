import * as Array from "effect/Array";
import * as Option from "effect/Option";
import { AuthorizeGitHub, ConnectRepository, FetchProjects, FetchThread } from "./commands.js";
import type { GitHubReport, Model, Project } from "./model.js";
import { Turn } from "./model.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";

/**
 * The sidebar: what the owner may work in, the GitHub connection, and connecting another
 * repository. Selecting a project is the only way this page names one, and it is a boundary: it
 * bumps `selection`, so a thread read for the project a reader left is dropped, and it stops any
 * turn still streaming.
 */

function withGitHub(model: Model, report: GitHubReport): Model {
  const github =
    report._tag === "Known"
      ? report.connection
      : { state: "unknown", detail: "", verificationUri: model.github.verificationUri };

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
    SucceededFetchProjects: ({ projects, github }) =>
      listedProjects(withGitHub(model, github), projects),
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

export function gitHubHandlers(
  model: Model,
): Handlers<"ClickedAuthorize" | "SucceededAuthorize" | "RejectedAuthorize" | "FailedAuthorize"> {
  return {
    ClickedAuthorize: ({ path }) => ({
      model: { ...clearError(model), github: { ...model.github, detail: "asking GitHub" } },
      commands: [AuthorizeGitHub({ path })],
    }),
    SucceededAuthorize: ({ github }) => ({ model: withGitHub(model, github) }),
    RejectedAuthorize: ({ wording }) => ({
      model: { ...model, github: { ...model.github, state: wording } },
    }),
    FailedAuthorize: ({ detail }) => ({
      model: {
        ...withError(model, "the GitHub authorization request", detail),
        github: { ...model.github, state: "request failed" },
      },
    }),
  };
}
