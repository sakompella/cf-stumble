import { describe, expect, it } from "vitest";

import { seedGenesis } from "../../src/generation/genesis.js";
import { GENESIS_NUMBER } from "../../src/generation/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
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
});
