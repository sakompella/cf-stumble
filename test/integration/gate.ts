import { readGeneration } from "../../src/generation/read.js";
import type { Attestation, Generation } from "../../src/generation/types.js";
import type { Sha } from "../../src/git/types.js";
import { runReplay } from "../../src/replay/index.js";
import type {
  PrimitiveCall,
  ReplayAgentLoop,
  ReplayOutcome,
  ReplaySession,
} from "../../src/replay/index.js";
import type { MemoryStore } from "../../src/storage/memory.js";
import {
  MemoryValidationResultStore,
  ValidationGate,
  type ValidationCase,
  type ValidationRun,
} from "../../src/validation/index.js";
import { ALLOW_POLICY, POLICY_PATH, moduleText } from "./fixtures.js";

const expectedReplayCalls: readonly PrimitiveCall[] = [
  { kind: "read", path: "README.md" },
  { kind: "write", path: "notes.txt", content: "created\n" },
  { kind: "edit", path: "src/app.ts", oldText: "1", newText: "2" },
  { kind: "bash", command: "printf 'ok\\n'" },
];

function replayAgentForPolicy(policy: string): ReplayAgentLoop {
  const calls: readonly PrimitiveCall[] =
    policy === ALLOW_POLICY
      ? expectedReplayCalls
      : [
          { kind: "read", path: "README.md" },
          { kind: "write", path: "notes.txt", content: "blocked\n" },
          { kind: "edit", path: "src/app.ts", oldText: "1", newText: "2" },
          { kind: "bash", command: "printf 'ok\\n'" },
        ];

  return {
    async runTurn(_input, runtime) {
      const response = await runtime.requestModel({ requestId: "executor" });
      if (response.content !== "run-four-primitives") {
        return {
          status: "inconclusive",
          reason: "malformed-response",
          detail: `unknown scripted response ${JSON.stringify(response.content)}`,
        };
      }
      for (const call of calls) {
        await runtime.callPrimitive(call);
      }
      return { status: "completed" };
    },
  };
}

async function executeGeneration(
  store: MemoryStore,
  generation: Sha | undefined,
  session: ReplaySession,
): Promise<ReplayOutcome> {
  if (generation === undefined) {
    throw new Error("validation requires a live generation");
  }
  const loaded = await readGeneration(store, generation);
  return runReplay(session, replayAgentForPolicy(moduleText(loaded.modules, POLICY_PATH)));
}

export async function validateCandidate(
  store: MemoryStore,
  candidate: Generation,
  session: ReplaySession,
): Promise<{
  readonly run: ValidationRun;
  readonly resultStore: MemoryValidationResultStore;
  readonly corpus: readonly ValidationCase[];
}> {
  const corpus: readonly ValidationCase[] = [
    { name: "four primitives remain executable", session, mandatoryCanary: true },
  ];
  const resultStore = new MemoryValidationResultStore();
  const gate = new ValidationGate({
    pointerStore: store,
    resultStore,
    corpus,
    execute: (generation, currentSession) => executeGeneration(store, generation, currentSession),
    now: () => 1_700_000_002,
  });
  return { run: await gate.validate(candidate.sha), resultStore, corpus };
}

export function requireAttestation(run: ValidationRun): Attestation {
  if (run.attestation === undefined) {
    throw new Error(`expected passing attestation, got ${run.result.verdict}`);
  }
  return run.attestation;
}
