import { HARNESS_DIRECTORY } from "../../src/workspace-layout.js";
import type { JsonValue } from "./json.mjs";

/**
 * The worlds the harness server can serve, and the recorded answers that are the same in all of
 * them.
 *
 * Every payload here copies the field names of the real route it stands in for, so a page that
 * reads a field the Supervisor does not send fails against this server too. The values are typed
 * as plain JSON rather than as the Supervisor's own types because those carry branded ids
 * (`ProjectId`, `HarnessCommit`, `GenerationLabel`) that only a parser can mint; a fixture that
 * asserted its way into a brand would prove nothing about the wire shape.
 *
 * A scenario names what cannot be reached by driving the page: which turn the Supervisor streams,
 * which GitHub state the workspace is in, whether the catalog is empty, and whether the status
 * route answers at all. Everything else — the thread, the generation ledger, the connected
 * repositories — is state the server keeps and a case changes by acting on the page.
 */

export const HARNESS_SCENARIOS = [
  "ready",
  "ready-paused",
  "no-terminal-frame",
  "no-diff",
  "diff-unavailable",
  "markup-output",
  "long-line",
  "tool-failed",
  "project-switch",
  "turn-failed",
  "save-failed",
  "stream-invalid",
  "cancelled",
  "timed-out",
  "turn-conflict",
  "no-active-generation",
  "no-projects",
  "github-disconnected",
  "github-awaiting-authorization",
  "status-problem",
] as const;

export type HarnessScenario = (typeof HARNESS_SCENARIOS)[number];

export function parseScenario(value: string | null | undefined): HarnessScenario | undefined {
  return HARNESS_SCENARIOS.find((scenario) => scenario === value);
}

/** The connected repository, and the harness checkout. The two working directories v0 allows. */
export const HARNESS_PROJECT_ID = "octocat-hello-world";
export const HARNESS_PROJECT_URL = "https://github.com/octocat/hello-world";
export const HARNESS_SELF_PROJECT_ID = "harness";
export const CONNECTED_PROJECT_ID = "octocat-new-repo";
export const CONNECTED_PROJECT_URL = "https://github.com/octocat/new-repo";
export const HARNESS_LOCATION = HARNESS_DIRECTORY;

export type ProjectEntry = Readonly<{
  kind: "repository" | "harness";
  id: string;
  displayName: string;
  repositoryUrl?: string;
}>;

export const BASELINE_PROJECTS: readonly ProjectEntry[] = [
  {
    kind: "repository",
    id: HARNESS_PROJECT_ID,
    displayName: "hello-world",
    repositoryUrl: HARNESS_PROJECT_URL,
  },
  { kind: "harness", id: HARNESS_SELF_PROJECT_ID, displayName: "harness" },
];

export const NEW_PROJECT: ProjectEntry = {
  kind: "repository",
  id: CONNECTED_PROJECT_ID,
  displayName: "new-repo",
  repositoryUrl: CONNECTED_PROJECT_URL,
};

export function initialProjects(scenario: HarnessScenario): readonly ProjectEntry[] {
  return scenario === "no-projects" ? [] : BASELINE_PROJECTS;
}

const CONNECTED_GITHUB = {
  state: "connected",
  login: "octocat",
  source: "owner-authorization",
} as const;

export function github(scenario: HarnessScenario): JsonValue {
  if (scenario === "github-disconnected") {
    return { state: "disconnected" };
  }
  if (scenario === "github-awaiting-authorization") {
    return {
      state: "awaiting-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
      expiresAt: 1_760_000_900_000,
      intervalSeconds: 5,
    };
  }
  return CONNECTED_GITHUB;
}

function projectJson(project: ProjectEntry): JsonValue {
  return project.repositoryUrl === undefined
    ? { kind: project.kind, id: project.id, displayName: project.displayName }
    : {
        kind: project.kind,
        id: project.id,
        displayName: project.displayName,
        repositoryUrl: project.repositoryUrl,
      };
}

/** The sidebar list, in the shape and the order the Supervisor sends it. */
export function projectsPayload(
  scenario: HarnessScenario,
  projects: readonly ProjectEntry[],
): JsonValue {
  return {
    ok: true,
    projects: projects.map((project) => projectJson(project)),
    github: github(scenario),
  };
}

export function connectPayload(scenario: HarnessScenario, alreadyConnected: boolean): JsonValue {
  return {
    ok: true,
    project: {
      id: NEW_PROJECT.id,
      displayName: NEW_PROJECT.displayName,
      repositoryUrl: CONNECTED_PROJECT_URL,
      connectedAt: 1_760_000_000_000,
    },
    alreadyConnected,
    github: github(scenario),
  };
}

export function authorizationPayload(scenario: HarnessScenario): JsonValue {
  return { ok: true, github: github(scenario) };
}
