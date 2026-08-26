import { readFile } from "node:fs/promises";
import { buildGeneration } from "../../src/generation/build.js";
import { seedGenesis } from "../../src/generation/genesis.js";
import type { Generation, Module } from "../../src/generation/types.js";
import { readGeneration } from "../../src/generation/read.js";
import { parseReplaySessionJson } from "../../src/replay/index.js";
import type { ReplaySession } from "../../src/replay/index.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { executePrimitive } from "../../src/tools/index.js";
import type { InMemoryWorkspace, PrimitiveResult, WriteResult } from "../../src/tools/index.js";
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
const fixtureUrl = new URL("../fixtures/sessions/four-primitives.json", import.meta.url);

export const genesisModules = [
  { path: PROMPT_PATH, content: encoder.encode("stable prompt\n"), executable: false },
  { path: POLICY_PATH, content: encoder.encode(ALLOW_POLICY), executable: false },
] satisfies readonly Module[];

export async function loadFixture(): Promise<ReplaySession> {
  return parseReplaySessionJson(await readFile(fixtureUrl, "utf8"));
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
  parent: Generation,
  prompt: string,
  policy: string,
  summary: string,
): Promise<Generation> {
  return buildGeneration(store, {
    modules: modulesFor(prompt, policy),
    parent,
    author,
    createdAt: parent.createdAt + 1,
    summary,
  });
}

export function buildPromptCandidate(store: MemoryStore, parent: Generation): Promise<Generation> {
  return buildChild(store, parent, "candidate prompt\n", ALLOW_POLICY, "change prompt");
}

function successfulWrite(result: PrimitiveResult): WriteResult {
  if (!result.ok || result.kind !== "write") {
    throw new Error(`turn write failed: ${result.ok ? result.kind : result.error.kind}`);
  }
  return result;
}

export function runConfiguredTurn(store: MemoryStore, workspace: InMemoryWorkspace) {
  return runPinnedTurn(store, async (generationSha) => {
    const loaded = await readGeneration(store, generationSha);
    const policy = moduleText(loaded.modules, POLICY_PATH);
    if (policy !== ALLOW_POLICY) {
      throw new Error(`unsupported turn policy ${JSON.stringify(policy)}`);
    }
    const write = await executePrimitive(
      {
        kind: "write",
        path: "turns.log",
        content: `${moduleText(loaded.modules, PROMPT_PATH)}turn\n`,
      },
      workspace,
    );
    return {
      generation: loaded.generation,
      write: successfulWrite(write),
    };
  });
}

export async function seedStore(): Promise<{
  readonly store: MemoryStore;
  readonly genesis: Generation;
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
