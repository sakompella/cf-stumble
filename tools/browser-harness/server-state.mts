import { setTimeout as sleep } from "node:timers/promises";
import { initialProjects, type HarnessScenario, type ProjectEntry } from "./fixtures.mjs";
import { INITIAL_GENERATION, type GenerationState } from "./fixtures-generation.mjs";
import { INITIAL_THREAD, type ThreadState } from "./fixtures-thread.mjs";
import type { JsonValue } from "./json.mjs";

/**
 * Everything the stub remembers, and the one thing a case can only learn from the stub.
 *
 * The page is what is under test, so what it sent is evidence and what it displays afterwards is
 * not: a case that read `#activate-sent-epoch` would be asking the page to confirm its own claim.
 * {@link RecordedRequest} is that independent record, in arrival order and with the answer's
 * status, so a case can compare the value a reader sees against the value that left the browser.
 *
 * {@link StreamWatch} is the other half. A turn that has ended proves nothing about streaming, so
 * the server can stop mid-response and say so, hold the rest until a case releases it, and report
 * that the browser closed the response — which is how a cancelled turn is observed from outside
 * the page.
 */

export type RecordedRequest = Readonly<{
  method: string;
  path: string;
  body: JsonValue;
  status: number;
}>;

export type RequestRecord = { method: string; path: string; body: JsonValue; status: number };

export type StreamWatch = {
  barrierReached: boolean;
  released: boolean;
  responseClosed: boolean;
  framesWritten: number;
};

export type ScenarioState = {
  scenario: HarnessScenario;
  projects: ProjectEntry[];
  readonly threads: Map<string, ThreadState>;
  generation: GenerationState;
  requests: RequestRecord[];
  stream: StreamWatch;
};

export function freshStreamWatch(): StreamWatch {
  return { barrierReached: false, released: false, responseClosed: false, framesWritten: 0 };
}

export function initialState(scenario: HarnessScenario): ScenarioState {
  return {
    scenario,
    projects: [...initialProjects(scenario)],
    threads: new Map<string, ThreadState>(),
    generation: INITIAL_GENERATION,
    requests: [],
    stream: freshStreamWatch(),
  };
}

/** Every project starts from the same saved thread; the map holds only the ones that moved. */
export function threadOf(state: ScenarioState, projectId: string): ThreadState {
  return state.threads.get(projectId) ?? INITIAL_THREAD;
}

export function resetState(state: ScenarioState, scenario: HarnessScenario): void {
  state.scenario = scenario;
  state.projects = [...initialProjects(scenario)];
  state.threads.clear();
  state.generation = INITIAL_GENERATION;
  state.requests = [];
  state.stream = freshStreamWatch();
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
