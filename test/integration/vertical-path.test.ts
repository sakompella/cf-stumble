import { expect, test } from "vitest";
import { buildGeneration } from "../../src/generation/build.js";
import { readGeneration } from "../../src/generation/read.js";
import { seedGenesis } from "../../src/generation/genesis.js";
import type { Module } from "../../src/generation/types.js";
import { InMemoryWorkspace, executePrimitive } from "../../src/tools/index.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { runPinnedTurn } from "../../src/integration/turn.js";

const author = {
  name: "Integration Bot",
  email: "integration@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const encoder = new TextEncoder();

const genesisModules = [
  { path: "prompt.md", content: encoder.encode("stable prompt\n"), executable: false },
  { path: "policy.md", content: encoder.encode("allow-all\n"), executable: false },
] satisfies readonly Module[];

function moduleByPath(modules: readonly Module[], path: string): Module {
  const module = modules.find((candidate) => candidate.path === path);
  if (module === undefined) {
    throw new Error(`missing module ${path}`);
  }
  return module;
}

function moduleText(modules: readonly Module[], path: string): string {
  return new TextDecoder().decode(moduleByPath(modules, path).content);
}

test("seeding starts generation 0, pins its turn, and builds a distinct candidate", async () => {
  const store = new MemoryStore();
  const genesis = await seedGenesis(store, {
    modules: genesisModules,
    author,
    createdAt: author.timestamp,
    summary: "stable genesis",
  });
  expect(await store.readPointer()).toBe(genesis.sha);

  const workspace = new InMemoryWorkspace({
    files: [{ path: "turns.txt", content: "generation 0\n" }],
  });
  const firstTurn = await runPinnedTurn(store, async (generationSha) => {
    const loaded = await readGeneration(store, generationSha);
    const write = await executePrimitive(
      { kind: "write", path: "turns.txt", content: `${moduleText(loaded.modules, "prompt.md")}turn\n` },
      workspace,
    );
    return { generation: loaded.generation, write };
  });

  expect(firstTurn.generation).toBe(genesis.sha);
  expect(firstTurn.result.generation.sha).toBe(genesis.sha);
  expect(firstTurn.result.write).toMatchObject({ ok: true, kind: "write" });

  const candidate = await buildGeneration(store, {
    modules: [
      {
        ...moduleByPath(genesisModules, "prompt.md"),
        content: encoder.encode("candidate prompt\n"),
      },
      moduleByPath(genesisModules, "policy.md"),
    ],
    parent: genesis,
    author,
    createdAt: author.timestamp + 1,
    summary: "change prompt",
  });

  expect(candidate.number).toBe(1);
  expect(candidate.parent).toBe(genesis.sha);
  expect(candidate.sha).not.toBe(genesis.sha);
  expect(await store.readPointer()).toBe(genesis.sha);
});
