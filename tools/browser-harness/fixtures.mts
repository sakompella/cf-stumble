import type { ANSWERS, AnsweredEndpoint } from "../../src/api/answers.js";
import { HARNESS_DIRECTORY } from "../../src/workspace-layout.js";

type Encoded<E extends AnsweredEndpoint> = (typeof ANSWERS)[E]["Encoded"];

export type HarnessScenario =
  | "ready"
  | "ready-paused"
  | "preparing-paused"
  | "model-error"
  | "cut-off"
  | "github-disconnected"
  | "github-awaiting-authorization"
  | "chatgpt-connected";

export const HARNESS_CREDENTIALS = { username: "aditya", password: "harness-password" } as const;

export const HARNESS_PROJECT_ID = "octocat-hello-world";

export const HARNESS_PROJECT_URL = "https://github.com/octocat/hello-world";

export const HARNESS_SELF_PROJECT_ID = "harness";

export const CONNECTED_PROJECT_ID = "octocat-new-repo";

export const CONNECTED_PROJECT_URL = "https://github.com/octocat/new-repo";

export function projectLocation(projectId: string): string {
  if (projectId === HARNESS_SELF_PROJECT_ID) {
    return HARNESS_DIRECTORY;
  }

  if (projectId === HARNESS_PROJECT_ID) {
    return HARNESS_PROJECT_URL;
  }

  return CONNECTED_PROJECT_URL;
}

export type ProjectEntry = Encoded<"GET /api/projects">["projects"][number];

export const BASELINE_PROJECTS: readonly ProjectEntry[] = [
  {
    kind: "repository",
    id: HARNESS_PROJECT_ID,
    displayName: "hello-world",
    repositoryUrl: HARNESS_PROJECT_URL,
  },
  { kind: "harness", id: HARNESS_SELF_PROJECT_ID, displayName: "harness" },
];

export const MISTYPED_REPOSITORY_URL = "https://github.com/octocat/Hello-Wrld";

export const TOO_LARGE_REPOSITORY_URL = "https://github.com/torvalds/linux";

export const NEW_PROJECT: ProjectEntry = {
  kind: "repository",
  id: CONNECTED_PROJECT_ID,
  displayName: "new-repo",
  repositoryUrl: CONNECTED_PROJECT_URL,
};

const CONNECTED_GITHUB = {
  state: "connected",
  login: "octocat",
  source: "device-authorization",
} as const;

export function github(scenario: HarnessScenario): Encoded<"GET /api/github/connection">["github"] {
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

export function projectsPayload(projects: readonly ProjectEntry[]): Encoded<"GET /api/projects"> {
  return { ok: true, projects };
}

export function connectPayload(alreadyConnected: boolean): Encoded<"POST /api/projects/connect"> {
  return {
    ok: true,
    project: {
      id: CONNECTED_PROJECT_ID,
      displayName: "new-repo",
      repositoryUrl: CONNECTED_PROJECT_URL,
    },
    alreadyConnected,
  };
}

export const CHECKED_AT = new Date(2026, 9, 15, 14, 32).getTime();

export const CHECKED_WORDING = "2026-10-15 14:32";

export function refreshPayload(
  scenario: HarnessScenario,
): Encoded<"POST /api/github/connection/refresh"> {
  return { ok: true, github: github(scenario), checkedAt: CHECKED_AT };
}

export const INITIAL_GENERATION_LABEL = 1;

export function statusPayload(label: number): Encoded<"GET /api/status"> {
  return {
    activeGeneration: {
      generation: { label, harnessCommit: `commit-${label}`, status: "ready" },
      epoch: 2 + label,
    },
    mainAhead: 2,
  };
}

export function chatgptPayload(isConnected: boolean): Encoded<"GET /api/chatgpt/connection"> {
  return {
    ok: true,
    chatgpt: {
      connection: isConnected
        ? { state: "connected", expiresAt: 1_760_000_900_000 }
        : { state: "disconnected" },
      login: null,
      model: "gpt-6.1-sol",
    },
  };
}
