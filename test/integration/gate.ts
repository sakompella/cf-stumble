import { AgentExecutor, materializeGeneration } from "../../src/agent/runtime/index.js";
import type { Attestation, Generation } from "../../src/generation/types.js";
import { assertNever } from "../../src/git/types.js";
import type { Sha } from "../../src/git/types.js";
import { runReplay } from "../../src/replay/index.js";
import type {
  PrimitiveCall,
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
import { ALLOW_POLICY } from "./fixtures.js";

const expectedReplayCalls: readonly PrimitiveCall[] = [
  { kind: "read", path: "README.md" },
  { kind: "write", path: "notes.txt", content: "created\n" },
  { kind: "edit", path: "src/app.ts", oldText: "1", newText: "2" },
  { kind: "bash", command: "printf 'ok\\n'" },
];

function replayAgentResponse(policy: string): string {
  const calls = expectedReplayCalls.map((call) =>
    call.kind === "write" && policy !== ALLOW_POLICY
      ? { ...call, content: "blocked\n" }
      : call,
  );
  return JSON.stringify({
    type: "tool_calls",
    calls: calls.map((call) => primitiveMessage(call)),
  });
}

function primitiveMessage(call: PrimitiveCall): { readonly name: string; readonly arguments: object } {
  switch (call.kind) {
    case "read":
      return { name: call.kind, arguments: { path: call.path } };
    case "write":
      return { name: call.kind, arguments: { path: call.path, content: call.content } };
    case "edit":
      return {
        name: call.kind,
        arguments: { path: call.path, oldText: call.oldText, newText: call.newText },
      };
    case "bash":
      return { name: call.kind, arguments: { command: call.command } };
    default:
      return assertNever(call, "primitive call");
  }
}

function sessionForPolicy(session: ReplaySession, policy: string): ReplaySession {
  return {
    ...session,
    turns: session.turns.map((turn) => ({
      ...turn,
      modelResponses: [
        ...turn.modelResponses.map((response, index) =>
          index === 0 ? { ...response, content: replayAgentResponse(policy) } : response,
        ),
        { requestId: "executor", content: JSON.stringify({ type: "final", content: "done" }) },
      ],
    })),
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
  const definition = await materializeGeneration(store, generation);
  return runReplay(
    sessionForPolicy(session, definition.policy),
    new AgentExecutor(definition),
  );
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
