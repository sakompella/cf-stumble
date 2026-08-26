import { describe, expect, it } from "vitest";

import {
  isGenesis,
  isGenesisGeneration,
  isGenesisSha,
  makeGenesisPin,
  resetToGenesis,
  seedGenesis,
} from "../../src/generation/genesis.js";
import { GENESIS_NUMBER } from "../../src/generation/types.js";
import { parseSha } from "../../src/git/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { buildGeneration } from "../../src/generation/build.js";
import type { Module } from "../../src/generation/types.js";

const author = {
  name: "Genesis Bot",
  email: "genesis@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const module = {
  path: "prompt.md",
  content: new TextEncoder().encode("known good\n"),
  executable: false,
} satisfies Module;

const options = {
  modules: [module],
  author,
  createdAt: author.timestamp,
  summary: "known-good genesis",
} as const;

describe("seedGenesis", () => {
  it("creates generation 0 without a parent and points the store at it", async () => {
    const store = new MemoryStore();

    const genesis = await seedGenesis(store, options);

    expect(genesis.number).toBe(GENESIS_NUMBER);
    expect(genesis.parent).toBeUndefined();
    expect(await store.readPointer()).toBe(genesis.sha);
  });

  it("is idempotent without adding objects on a second seed", async () => {
    const store = new MemoryStore();

    const first = await seedGenesis(store, options);
    const objectsAfterFirstSeed = await store.listObjects();
    const second = await seedGenesis(store, options);

    expect(second.sha).toBe(first.sha);
    expect(await store.listObjects()).toHaveLength(objectsAfterFirstSeed.length);
    expect(await store.listObjects()).toEqual(objectsAfterFirstSeed);
  });
});

describe("resetToGenesis", () => {
  it("moves the live pointer from a later generation to generation 0", async () => {
    const store = new MemoryStore();
    const genesis = await seedGenesis(store, options);
    const later = await buildGeneration(store, {
      ...options,
      parent: genesis,
      createdAt: author.timestamp + 1,
      summary: "later generation",
    });
    const pin = makeGenesisPin(genesis);
    expect(await store.setPointer(later.sha, genesis.sha)).toBe(true);

    const result = await resetToGenesis(store, pin);

    expect(result).toEqual({ outcome: "reset", from: later.sha, to: genesis.sha });
    expect(await store.readPointer()).toBe(genesis.sha);
  });
});

describe("genesis identification", () => {
  it("identifies generation 0 and its pinned sha", async () => {
    const store = new MemoryStore();
    const genesis = await seedGenesis(store, options);
    const pin = makeGenesisPin(genesis);

    expect(isGenesisGeneration(genesis)).toBe(true);
    expect(isGenesis(genesis)).toBe(true);
    expect(isGenesisSha(genesis.sha, pin)).toBe(true);
    expect(isGenesis(genesis.sha, pin)).toBe(true);
    expect(isGenesisSha(parseSha("ffffffffffffffffffffffffffffffffffffffff"), pin)).toBe(false);
  });
});
