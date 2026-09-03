/// <reference types="@cloudflare/vitest-plugin/types" />

import type { OwnerApiSupervisor } from "../../src/routes/index.js";
import type { SessionRecord } from "../../src/supervisor/sessions/index.js";

/** A stand-in Supervisor for boundary tests. Each test overrides only the call it exercises. */
export function ownerApiSupervisor(
  overrides: Partial<OwnerApiSupervisor> = {},
): OwnerApiSupervisor {
  return {
    getActiveGeneration() {
      return Promise.resolve({ generation: undefined, epoch: 0, activationId: undefined });
    },
    getSession(_sessionId) {
      return Promise.resolve<SessionRecord | undefined>(void 0);
    },
    runSessionTurn() {
      return Promise.resolve({
        ok: true,
        response: { text: "reply", commands: [], sessionRevision: 1 },
      });
    },
    controlGeneration() {
      return Promise.reject(new Error("this test must not reach generation control"));
    },
    getLatestRecoveryEpisode() {
      return Promise.resolve(void 0);
    },
    ...overrides,
  };
}

/** The body stays raw text so a malformed request reaches the route exactly as it was sent. */
export function controlRequest(path: string, body: string): Request {
  return new Request(`https://cf-stumble.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}
