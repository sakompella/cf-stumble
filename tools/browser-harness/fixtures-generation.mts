import type { HarnessScenario } from "./fixtures.mjs";
import type { JsonValue } from "./json.mjs";

/**
 * The generation ledger the stub keeps, and what each generation command does to it.
 *
 * The drawer's whole point is concurrency: activation and rollback carry the epoch the page
 * rendered, and the Supervisor refuses a command that observed an older one (ADR-0033). A stub
 * with a frozen epoch could not tell a page that sends what it displays from one that sends
 * whatever the server last said, so the epoch lives here and every accepted command advances it.
 */

export type GenerationStatus = "ready" | "failed";

export type GenerationRecord = Readonly<{
  label: number;
  harnessCommit: string;
  status: GenerationStatus;
}>;

export type GenerationState = Readonly<{
  generations: readonly GenerationRecord[];
  activeLabel: number;
  epoch: number;
}>;

export const FIRST_GENERATION: GenerationRecord = {
  label: 1,
  harnessCommit: "abc123",
  status: "ready",
};

export const READY_CANDIDATE_COMMIT = "def456";

export const BROKEN_CANDIDATE_COMMIT = "broken456";

export const INITIAL_GENERATION: GenerationState = {
  generations: [FIRST_GENERATION],
  activeLabel: 1,
  epoch: 3,
};

/** One answer to a generation command: what the page receives, and where the ledger stands after. */
export type GenerationAnswer = Readonly<{
  status: number;
  payload: JsonValue;
  next: GenerationState;
}>;

function generationJson(record: GenerationRecord): JsonValue {
  return { label: record.label, harnessCommit: record.harnessCommit, status: record.status };
}

function active(state: GenerationState): GenerationRecord {
  return state.generations.find((record) => record.label === state.activeLabel) ?? FIRST_GENERATION;
}

export function statusPayload(state: GenerationState, scenario: HarnessScenario): GenerationAnswer {
  if (scenario === "status-problem") {
    return {
      status: 503,
      payload: { ok: false, problem: { code: "status-unavailable" } },
      next: state,
    };
  }

  return {
    status: 200,
    payload: {
      activeGeneration: {
        generation: generationJson(active(state)),
        epoch: state.epoch,
        activationId: `activation-${state.epoch}`,
      },
    },
    next: state,
  };
}

function preparation(record: GenerationRecord): JsonValue {
  if (record.status === "failed") {
    return { ok: false, problem: { code: "startup-check-failed" } };
  }

  return {
    ok: true,
    report: {
      generation: generationJson(record),
      effect: "recorded",
      stage: "ready",
      reason: "startup check answered",
      status: 200,
    },
  };
}

function submitted(state: GenerationState, record: GenerationRecord): GenerationAnswer {
  return {
    status: 200,
    payload: {
      ok: true,
      outcome: {
        kind: "candidate-submitted",
        generation: generationJson(record),
        epoch: state.epoch,
      },
      preparation: preparation(record),
    },
    next: state,
  };
}

export function submitGeneration(state: GenerationState, harnessCommit: string): GenerationAnswer {
  const existing = state.generations.find((record) => record.harnessCommit === harnessCommit);

  if (existing !== undefined) {
    return submitted(state, existing);
  }

  const labels = state.generations.map((record) => record.label);

  const record: GenerationRecord = {
    label: Math.max(0, ...labels) + 1,
    harnessCommit,
    status: harnessCommit === BROKEN_CANDIDATE_COMMIT ? "failed" : "ready",
  };

  return submitted({ ...state, generations: [...state.generations, record] }, record);
}

function refused(state: GenerationState, status: number, code: string): GenerationAnswer {
  return { status, payload: { ok: false, problem: { code } }, next: state };
}

export function runGenerationCommand(
  state: GenerationState,
  kind: "activate" | "rollback",
  observedEpoch: number,
  label: number,
): GenerationAnswer {
  if (observedEpoch !== state.epoch) {
    return refused(state, 409, "stale-epoch");
  }

  const record = state.generations.find((candidate) => candidate.label === label);

  if (record === undefined) {
    return refused(state, 404, "unknown-generation");
  }

  if (record.status !== "ready") {
    return refused(state, 409, "generation-not-ready");
  }

  const changed = record.label !== state.activeLabel;
  const outcome = kind === "activate" ? "activated" : "rolled-back";

  const next: GenerationState = changed
    ? { ...state, activeLabel: record.label, epoch: state.epoch + 1 }
    : state;

  return {
    status: 200,
    payload: {
      ok: true,
      outcome: {
        kind: outcome,
        generation: generationJson(record),
        epoch: next.epoch,
        effect: changed ? outcome : "no-change",
      },
    },
    next,
  };
}
