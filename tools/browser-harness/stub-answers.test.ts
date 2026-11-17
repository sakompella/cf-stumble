import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWERS } from "../../src/api/answers.ts";
import { BASELINE_PROJECTS, type HarnessScenario } from "./fixtures.mts";
import { JSON_ROUTES } from "./server-routes.mts";

const SCENARIOS: readonly HarnessScenario[] = [
  "ready",
  "ready-paused",
  "model-error",
  "cut-off",
  "github-disconnected",
  "github-awaiting-authorization",
  "chatgpt-connected",
];

const BACKENDS = ["provider", "cloudflare"] as const;

const ENDPOINTS = [
  "GET /api/projects",
  "GET /api/status",
  "GET /api/chatgpt/connection",
  "GET /api/workspace/backend",
  "POST /api/workspace/backend",
  "POST /api/projects/connect",
  "POST /api/chatgpt/disconnect",
  "GET /api/github/connection",
  "POST /api/github/connection/refresh",
] as const satisfies readonly (keyof typeof JSON_ROUTES)[];

test("every answer the stub sends decodes with the API's answer schema for its endpoint", () => {
  hegel.test((tc) => {
    const state = {
      scenario: tc.draw(gs.sampledFrom(SCENARIOS)),
      projects: [...BASELINE_PROJECTS],
      isChatGPTConnected: false,
      generationLabel: 1,
      backend: tc.draw(gs.sampledFrom(BACKENDS)),
      isContainerRunning: tc.draw(gs.booleans()),
    };

    const calls = tc.draw(gs.arrays(gs.sampledFrom(ENDPOINTS), { minSize: 1, maxSize: 6 }));

    for (const endpoint of calls) {
      const { status, payload } = JSON_ROUTES[endpoint](state, {
        repositoryUrl: "https://github.com/octocat/new-repo",
        backend: tc.draw(gs.sampledFrom(BACKENDS)),
      });

      assert.equal(status, 200);
      assert.ok(
        Schema.is(ANSWERS[endpoint])(payload),
        `${endpoint} in ${state.scenario}: ${JSON.stringify(payload)}`,
      );
    }
  });
});
