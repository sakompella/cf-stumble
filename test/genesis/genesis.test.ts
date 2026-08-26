import { describe, expect, it } from "vitest";

import {
  isGenesis,
  isGenesisCommit,
  isGenesisSha,
  makeGenesisPin,
  assertGenesisReachable,
  resetToGenesis,
  seedGenesis,
} from "../../src/generation/genesis.js";
import { parseSha } from "../../src/git/types.js";
import { parseGenerationNumber } from "../../src/generation/types.js";
import { buildGeneration } from "../../src/generation/build.js";
import type { Sha } from "../../src/git/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { Module } from "../../src/generation/types.js";
import type { Store } from "../../src/storage/types.js";
import { PointerManager } from "../../src/pointer/index.js";

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

function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrived += 1;
    if (arrived === parties) {
      if (release === undefined) {
        throw new Error("barrier release was not initialized");
      }
      release();
    }
    await allArrived;
  };
}

type TestStoreOptions = {
  readonly corruptSha?: Sha;
  readonly barrier?: () => Promise<void>;
};

class TestStore implements Store {
  readObjectCalls = 0;
  private pointerReads = 0;
  private readonly delegate: MemoryStore;
  private readonly corruptSha: Sha | undefined;
  private readonly barrier: (() => Promise<void>) | undefined;

  constructor(delegate: MemoryStore, storeOptions: TestStoreOptions = {}) {
    this.delegate = delegate;
    this.corruptSha = storeOptions.corruptSha;
    this.barrier = storeOptions.barrier;
  }

  readObject(sha: Sha): Promise<Uint8Array | undefined> {
    this.readObjectCalls += 1;
    if (sha === this.corruptSha) {
      return Promise.resolve(new Uint8Array([255]));
    }
    return this.delegate.readObject(sha);
  }

  writeObject(bytes: Uint8Array): Promise<Sha> {
    return this.delegate.writeObject(bytes);
  }

  async readPointer(): Promise<Sha | undefined> {
    this.pointerReads += 1;
    if (this.barrier !== undefined && this.pointerReads <= 2) {
      await this.barrier();
    }
    return this.delegate.readPointer();
  }

  setPointer(next: Sha, expected: Sha | undefined): Promise<boolean> {
    return this.delegate.setPointer(next, expected);
  }
}

describe("seedGenesis", () => {
  it("creates the genesis commit without a parent and points the store at it", async () => {
    const store = new MemoryStore();

    const genesis = await seedGenesis(store, options);

    expect(genesis).not.toHaveProperty("number");
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

  it("claims generation 0 when the live pointer is unset", async () => {
    const store = new MemoryStore();
    const genesis = await buildGeneration(store, { ...options, parent: undefined });
    const pin = makeGenesisPin(genesis);

    const result = await resetToGenesis(store, pin);

    expect(result).toEqual({ outcome: "reset", from: undefined, to: genesis.sha });
    expect(await store.readPointer()).toBe(genesis.sha);
  });
});

describe("resetToGenesis recovery", () => {
  it("resets when the live generation commit is missing", async () => {
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
    await store.deleteObject(later.sha);

    await resetToGenesis(store, pin);

    expect(await store.readPointer()).toBe(genesis.sha);
  });

  it("resets when the live generation object is corrupt without reading it", async () => {
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
    const corruptStore = new TestStore(store, { corruptSha: later.sha });

    await resetToGenesis(corruptStore, pin);

    expect(await corruptStore.readPointer()).toBe(genesis.sha);
    expect(corruptStore.readObjectCalls).toBe(0);
  });
});

describe("genesis reset concurrency", () => {
  it("keeps reset and promotion on complete pointer values", async () => {
    const baseStore = new MemoryStore();
    const genesis = await seedGenesis(baseStore, options);
    const live = await buildGeneration(baseStore, {
      ...options,
      parent: genesis,
      createdAt: author.timestamp + 1,
      summary: "live generation",
    });
    const candidate = await buildGeneration(baseStore, {
      ...options,
      parent: live,
      createdAt: author.timestamp + 2,
      summary: "candidate generation",
    });
    expect(await baseStore.setPointer(live.sha, genesis.sha)).toBe(true);
    const store = new TestStore(baseStore, { barrier: makeBarrier(2) });
    const manager = new PointerManager({
      store,
      corpusVersion: "corpus-1",
      gateVersion: "gate-1",
    });
    const attestation = {
      candidate: candidate.sha,
      generation: parseGenerationNumber(0),
      artifactDigest: candidate.sha,
      validatedAgainst: live.sha,
      validatedAgainstGeneration: parseGenerationNumber(0),
      corpusVersion: "corpus-1",
      gateVersion: "gate-1",
      verdict: "pass",
      createdAt: author.timestamp + 2,
    } as const;

    const [resetResult, promotionResult] = await Promise.all([
      resetToGenesis(store, makeGenesisPin(genesis)),
      manager.promote(candidate.sha, attestation),
    ]);

    expect(resetResult.outcome).toBe("reset");
    if (promotionResult.outcome === "promoted") {
      expect(promotionResult.from).toBe(live.sha);
      expect(promotionResult.to).toBe(candidate.sha);
    } else {
      expect(["pointer-moved", "stale-attestation"]).toContain(promotionResult.reason.kind);
    }
    expect(await baseStore.readPointer()).toBe(genesis.sha);
  });
});

describe("genesis identification", () => {
  it("identifies generation 0 and its pinned sha", async () => {
    const store = new MemoryStore();
    const genesis = await seedGenesis(store, options);
    const pin = makeGenesisPin(genesis);

    expect(isGenesisCommit(genesis)).toBe(true);
    expect(isGenesis(genesis)).toBe(true);
    expect(isGenesisSha(genesis.sha, pin)).toBe(true);
    expect(isGenesis(genesis.sha, pin)).toBe(true);
    expect(isGenesisSha(parseSha("ffffffffffffffffffffffffffffffffffffffff"), pin)).toBe(false);
  });

  it("asserts that a later generation reaches the pinned root", async () => {
    const store = new MemoryStore();
    const genesis = await seedGenesis(store, options);
    const later = await buildGeneration(store, {
      ...options,
      parent: genesis,
      createdAt: author.timestamp + 1,
      summary: "later generation",
    });
    const pin = makeGenesisPin(genesis);

    await expect(assertGenesisReachable(store, later.sha, pin)).resolves.toBeUndefined();
    expect(isGenesisCommit(later)).toBe(false);
  });
});
