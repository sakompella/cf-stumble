import { setTimeout as sleep } from "node:timers/promises";
import { initialChatGPT, type ChatGPTState } from "./fixtures-chatgpt.mjs";
import { initialProjects, type HarnessScenario, type ProjectEntry } from "./fixtures.mjs";
import { INITIAL_GENERATION, type GenerationState } from "./fixtures-generation.mjs";
import type { Conversations } from "./conversations.mjs";
import type { JsonValue } from "../json.mjs";

/**
 * Everything the stub remembers, and the one thing a case can only learn from the stub.
 *
 * The page is what is under test, so what it sent is evidence and what it displays afterwards is
 * not: a case that read `#activate-sent-epoch` would be asking the page to confirm its own claim.
 * {@link RecordedRequest} is that independent record, in arrival order and with the answer's
 * status, so a case can compare the value a reader sees against the value that left the browser.
 * `openEventStreams` counts the events responses the browser still holds open, per project, which
 * is how a case sees from outside the page that it stopped reading one.
 */

export type RecordedRequest = Readonly<{
  method: string;
  path: string;
  body: JsonValue;
  status: number;
}>;

export type RequestRecord = { method: string; path: string; body: JsonValue; status: number };

export type ScenarioState = {
  scenario: HarnessScenario;
  projects: ProjectEntry[];
  generation: GenerationState;
  chatgpt: ChatGPTState;
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
    projects: [...initialProjects(scenario)],
    generation: INITIAL_GENERATION,
    chatgpt: initialChatGPT(scenario),
    requests: [],
    conversations,
    openEventStreams: new Map(),
  };
}

/** Poll one fact of the stub's state. A timeout names what did not happen, not a numeric code. */
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
