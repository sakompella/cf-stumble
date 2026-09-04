/// <reference types="@cloudflare/vitest-plugin/types" />

import type { OwnerApiSupervisor } from "../../src/routes/index.js";
import {
  emptyThread,
  serializedThread,
  type ProjectThreadResult,
} from "../../src/supervisor/threads/index.js";
import { PROJECT_CATALOG } from "../../src/project-catalog.js";

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
    ...overrides,
  };
}

/** Stands in for the catalog: the first catalog project has a thread, and nothing else does. */
function unknownProjectOr(projectId: string): ProjectThreadResult {
  const [firstProject] = PROJECT_CATALOG;
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
