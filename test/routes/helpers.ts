/// <reference types="@cloudflare/vitest-plugin/types" />

import type { OwnerApiSupervisor } from "../../src/routes/index.js";
import {
  emptyThread,
  serializedThread,
  type ProjectThreadResult,
} from "../../src/supervisor/threads/index.js";
import { sampleProjectOne } from "../project-fixtures.js";
import type { VerifiedAccessScope } from "../../src/supervisor/projects/index.js";

/**
 * The verified scope the Worker hands the owner API. Boundary tests pass it explicitly, because
 * the routes take the tenant from the boundary and never from request data.
 */
export const ownerScope: VerifiedAccessScope = {
  identity: "owner-subject",
  audience: "owner-api-audience",
};

/** A stand-in Supervisor for boundary tests. Each test overrides only the call it exercises. */
export function ownerApiSupervisor(
  overrides: Partial<OwnerApiSupervisor> = {},
): OwnerApiSupervisor {
  return {
    getActiveGeneration() {
      return Promise.resolve({ generation: undefined, epoch: 0, activationId: undefined });
    },
    getProjectThread(projectId) {
      return Promise.resolve(unknownProjectOr(projectId));
    },
    startFreshProjectThread(projectId) {
      return Promise.resolve(unknownProjectOr(projectId));
    },
    controlGeneration() {
      return Promise.reject(new Error("this test must not reach generation control"));
    },
    prepareGeneration() {
      return Promise.reject(new Error("this test must not reach generation preparation"));
    },
    getLatestRecoveryEpisode() {
      return Promise.resolve(void 0);
    },
    listProjects() {
      return Promise.resolve({ projects: [], github: { state: "disconnected" } });
    },
    connectProject() {
      return Promise.reject(new Error("this test must not connect a repository"));
    },
    getGitHubConnection() {
      return Promise.resolve({ state: "disconnected" });
    },
    startGitHubAuthorization() {
      return Promise.reject(new Error("this test must not start a GitHub authorization"));
    },
    completeGitHubAuthorization() {
      return Promise.reject(new Error("this test must not complete a GitHub authorization"));
    },
    ...overrides,
  };
}

/** Stands in for the catalog: the first catalog project has a thread, and nothing else does. */
function unknownProjectOr(projectId: string): ProjectThreadResult {
  const firstProject = sampleProjectOne;
  return projectId === firstProject.id
    ? { ok: true, thread: serializedThread(emptyThread(firstProject.id)) }
    : { ok: false, problem: { code: "unknown-project-id" } };
}

/** The body stays raw text so a malformed request reaches the route exactly as it was sent. */
export function controlRequest(path: string, body: string): Request {
  return new Request(`https://cf-stumble.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}
