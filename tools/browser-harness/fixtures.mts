import type { JsonValue } from "../json.mjs";

export type HarnessScenario =
  | "ready"
  | "ready-paused"
  | "model-error"
  | "github-disconnected"
  | "github-awaiting-authorization";

export const HARNESS_PROJECT_ID = "octocat-hello-world";

export const HARNESS_PROJECT_URL = "https://github.com/octocat/hello-world";

export const HARNESS_SELF_PROJECT_ID = "harness";

export const CONNECTED_PROJECT_ID = "octocat-new-repo";

export const CONNECTED_PROJECT_URL = "https://github.com/octocat/new-repo";

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

export function refreshPayload(scenario: HarnessScenario): JsonValue {
  return { ok: true, github: github(scenario), checkedAt: CHECKED_AT };
}

export const STATUS_PAYLOAD: JsonValue = {
  activeGeneration: {
    generation: { label: 1, harnessCommit: "abc123", status: "ready" },
    epoch: 3,
  },
};

export const CHATGPT_PAYLOAD: JsonValue = {
  ok: true,
  chatgpt: { connection: { state: "disconnected" }, login: null, model: "gpt-6.1-sol" },
};
