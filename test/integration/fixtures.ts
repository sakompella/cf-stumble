import fixtureData from "../fixtures/sessions/four-primitives.json";
import { buildGeneration } from "../../src/generation/build.js";
import { seedGenesis } from "../../src/generation/genesis.js";
import type { CommitSnapshot, Module } from "../../src/generation/types.js";
import {
  AgentExecutor,
  LiveModelResponseSource,
  materializeGeneration,
} from "../../src/agent/runtime/index.js";
import { parseReplaySession } from "../../src/replay/index.js";
import type { ReplaySession } from "../../src/replay/index.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { InMemoryWorkspace, WriteResult } from "../../src/tools/index.js";
import { runPinnedTurn } from "../../src/integration/turn.js";

export const author = {
  name: "Integration Bot",
  email: "integration@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const POLICY_PATH = "policy.md";
export const PROMPT_PATH = "prompt.md";
export const ALLOW_POLICY = "allow-all\n";
export const genesisModules = [
  { path: PROMPT_PATH, content: encoder.encode("stable prompt\n"), executable: false },
  { path: POLICY_PATH, content: encoder.encode(ALLOW_POLICY), executable: false },
] satisfies readonly Module[];

export function loadFixture(): Promise<ReplaySession> {
  const untrustedFixture = structuredClone(fixtureData);
  return Promise.resolve(parseReplaySession(untrustedFixture));
}

export function moduleByPath(modules: readonly Module[], path: string): Module {
  const module = modules.find((candidate) => candidate.path === path);
  if (module === undefined) {
    throw new Error(`missing module ${path}`);
  }
  return module;
}

export function moduleText(modules: readonly Module[], path: string): string {
  return decoder.decode(moduleByPath(modules, path).content);
}

export function modulesFor(prompt: string, policy: string): readonly Module[] {
  return [
    { path: PROMPT_PATH, content: encoder.encode(prompt), executable: false },
    { path: POLICY_PATH, content: encoder.encode(policy), executable: false },
  ];
}

export function buildChild(
  store: MemoryStore,
  parent: CommitSnapshot,
  prompt: string,
  policy: string,
  summary: string,
): Promise<CommitSnapshot> {
  return buildGeneration(store, {
    modules: modulesFor(prompt, policy),
    parent,
    author,
    createdAt: parent.createdAt + 1,
    summary,
  });
}

export function buildPromptCandidate(
  store: MemoryStore,
  parent: CommitSnapshot,
): Promise<CommitSnapshot> {
  return buildChild(store, parent, "candidate prompt\n", ALLOW_POLICY, "change prompt");
}

export function runConfiguredTurn(store: MemoryStore, workspace: InMemoryWorkspace) {
  return runPinnedTurn(store, async (generationSha) => {
    // Every generation exercised here is built by this test module's own fixtures, so a
    // materialization failure is a defect in the fixture, not a condition to report.
    const definition = (await materializeGeneration(store, generationSha)).unwrap(
      "integration fixture generation failed to materialize",
    );
    if (definition.policy !== ALLOW_POLICY) {
      throw new Error(`unsupported turn policy ${JSON.stringify(definition.policy)}`);
    }
    const content = `${definition.systemPrompt}turn\n`;
    const turn = await new AgentExecutor(definition).executeTurn(
      "append a turn",
      new LiveModelResponseSource((request) =>
        request.toolResults.length === 0
          ? JSON.stringify({
              type: "tool_call",
              name: "write",
              arguments: { path: "turns.log", content },
            })
          : JSON.stringify({ type: "final", content: "turn appended" }),
      ),
      workspace,
      { name: "integration-turn", seed: 0, nowMs: definition.generation.createdAt },
    );
    if (turn.status !== "completed") {
      throw new Error(`turn failed: ${turn.failure.kind}`);
    }
    const write = turn.trace.find(
      (call): call is { readonly kind: "write"; readonly path: string; readonly content: string } =>
        call.kind === "write" && call.path === "turns.log" && call.content === content,
    );
    if (write === undefined) {
      throw new Error("turn completed without the configured write");
    }
    const result: WriteResult = {
      kind: "write",
      bytesWritten: encoder.encode(write.content).byteLength,
    };
    return { generation: definition.generation, write: result };
  });
}

export async function seedStore(): Promise<{
  readonly store: MemoryStore;
  readonly genesis: CommitSnapshot;
}> {
  const store = new MemoryStore();
  const genesis = await seedGenesis(store, {
    modules: genesisModules,
    author,
    createdAt: author.timestamp,
    summary: "stable genesis",
  });
  return { store, genesis };
}
