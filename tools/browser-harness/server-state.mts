import { setTimeout as sleep } from "node:timers/promises";
import { BASELINE_PROJECTS, type HarnessScenario, type ProjectEntry } from "./fixtures.mjs";
import type { Conversations } from "./conversations.mjs";
import type { JsonValue } from "../json.mjs";

export type RecordedRequest = Readonly<{
  method: string;
  path: string;
  body: JsonValue;
  status: number;
}>;

export type RequestRecord = { method: string; path: string; body: JsonValue; status: number };

export type ScenarioState = {
  readonly scenario: HarnessScenario;
  projects: ProjectEntry[];
  requests: RequestRecord[];
  conversations: Conversations;
  readonly openEventStreams: Map<string, number>;
};

export function initialState(
  scenario: HarnessScenario,
  conversations: Conversations,
): ScenarioState {
  return {
    scenario,
    projects: [...BASELINE_PROJECTS],
    requests: [],
    conversations,
    openEventStreams: new Map(),
  };
}

export async function waitUntil(
  held: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!held()) {
    if (Date.now() > deadline) {
      throw new Error(`waited ${timeoutMs}ms for ${what}, which did not happen`);
    }

    await sleep(20);
  }
}
