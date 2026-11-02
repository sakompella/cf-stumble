import { HARNESS_DIRECTORY } from "../../src/workspace-layout.js";
import type { JsonValue } from "../json.mjs";

export const HARNESS_SCENARIOS = [
  "ready",
  "ready-paused",
  "model-error",
  "workspace-busy",
  "no-active-generation",
  "no-projects",
  "github-disconnected",
  "github-awaiting-authorization",
  "chatgpt-connected",
  "chatgpt-needs-reconnect",
  "status-problem",
] as const;

export type HarnessScenario = (typeof HARNESS_SCENARIOS)[number];

export function parseScenario(value: string | null | undefined): HarnessScenario | undefined {
  return HARNESS_SCENARIOS.find((scenario) => scenario === value);
}

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

export function projectsPayload(projects: readonly ProjectEntry[]): JsonValue {
  return { ok: true, projects: projects.map((project) => projectJson(project)) };
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
    checkedAt: CHECKED_AT,
  };
}

export const CHECKED_AT = new Date(2026, 9, 15, 14, 32).getTime();

export const CHECKED_WORDING = "2026-10-15 14:32";

export function authorizationPayload(scenario: HarnessScenario): JsonValue {
  return { ok: true, github: github(scenario), checkedAt: CHECKED_AT };
}

export function refreshPayload(scenario: HarnessScenario): JsonValue {
  return { ok: true, github: github(scenario), checkedAt: CHECKED_AT };
}
