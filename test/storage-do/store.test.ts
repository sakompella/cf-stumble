/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { parseSha } from "../../src/git/types.js";
import type { Sha } from "../../src/git/types.js";
import { describeStoreConformance } from "../../src/storage/conformance.js";
import { DurableObjectSqliteStore } from "../../src/storage/do-sqlite.js";
import type { SweepableStore } from "../../src/storage/types.js";

const CHUNK_SIZE = 512 * 1024;

type SupervisorStub = ReturnType<typeof env.SUPERVISOR.getByName>;

class TestStore implements SweepableStore {
  private readonly stub: SupervisorStub;

  constructor(stub: SupervisorStub) {
    this.stub = stub;
  }

  readObject(sha: Parameters<SweepableStore["readObject"]>[0]): Promise<Uint8Array | undefined> {
    return runInDurableObject(this.stub, (_instance, state) => {
      return new DurableObjectSqliteStore(state).readObject(sha);
    });
  }

  writeObject(bytes: Uint8Array): ReturnType<SweepableStore["writeObject"]> {
    return runInDurableObject(this.stub, (_instance, state) => {
      return new DurableObjectSqliteStore(state).writeObject(bytes);
    });
  }

  readPointer(): ReturnType<SweepableStore["readPointer"]> {
    return runInDurableObject(this.stub, (_instance, state) => {
      return new DurableObjectSqliteStore(state).readPointer();
    });
  }

  setPointer(
    next: Parameters<SweepableStore["setPointer"]>[0],
    expected: Parameters<SweepableStore["setPointer"]>[1],
  ): ReturnType<SweepableStore["setPointer"]> {
    return runInDurableObject(this.stub, (_instance, state) => {
      return new DurableObjectSqliteStore(state).setPointer(next, expected);
    });
  }

  listObjects(): ReturnType<SweepableStore["listObjects"]> {
    return runInDurableObject(this.stub, (_instance, state) => {
      return new DurableObjectSqliteStore(state).listObjects();
    });
  }

  deleteObject(sha: Parameters<SweepableStore["deleteObject"]>[0]): Promise<void> {
    return runInDurableObject(this.stub, (_instance, state) => {
      return new DurableObjectSqliteStore(state).deleteObject(sha);
    });
  }

  countChunkRows(): Promise<number> {
    return runInDurableObject(this.stub, (_instance, state) => {
      new DurableObjectSqliteStore(state);
      const rows = state.storage.sql
        .exec<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM cf_stumble_object_chunks",
        )
        .toArray();
      return rows[0]?.count ?? 0;
    });
  }

  installChunkWriteFailure(chunkIndex: number): Promise<void> {
    return runInDurableObject(this.stub, (_instance, state) => {
      new DurableObjectSqliteStore(state);
      state.storage.sql.exec(`
        CREATE TRIGGER cf_stumble_test_abort_chunk_write
        BEFORE INSERT ON cf_stumble_object_chunks
        WHEN NEW.chunk_index = ${chunkIndex}
        BEGIN
          SELECT RAISE(ABORT, 'interrupted chunk write');
        END
      `);
    });
  }
}

function makeStore(): Promise<TestStore> {
  const name = `storage-conformance-${crypto.randomUUID()}`;
  return Promise.resolve(new TestStore(env.SUPERVISOR.getByName(name)));
}

function makeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function shaFor(bytes: Uint8Array): Promise<Sha> {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return parseSha(bytesToHex(new Uint8Array(digest)));
}

afterEach(async () => {
  await reset();
});

describeStoreConformance("DurableObjectSqliteStore", makeStore);

describe("DurableObjectSqliteStore chunking", () => {
  it("round-trips an object larger than the single-row limit", async () => {
    const store = await makeStore();
    const input = makeBytes(4 * 1024 * 1024);

    const address = await store.writeObject(input);

    expect(await store.readObject(address)).toEqual(input);
  }, 30_000);

  it("round-trips an object exactly one chunk long", async () => {
    const store = await makeStore();
    const input = makeBytes(CHUNK_SIZE);

    const address = await store.writeObject(input);

    expect(await store.readObject(address)).toEqual(input);
  });

  it("round-trips an object one byte larger than one chunk", async () => {
    const store = await makeStore();
    const input = makeBytes(CHUNK_SIZE + 1);

    const address = await store.writeObject(input);

    expect(await store.readObject(address)).toEqual(input);
  });

  it("round-trips an object one byte smaller than one chunk", async () => {
    const store = await makeStore();
    const input = makeBytes(CHUNK_SIZE - 1);

    const address = await store.writeObject(input);

    expect(await store.readObject(address)).toEqual(input);
  });

  it("round-trips an empty object", async () => {
    const store = await makeStore();

    const address = await store.writeObject(new Uint8Array());

    expect(await store.readObject(address)).toEqual(new Uint8Array());
  });

  it("leaves no readable object after an interrupted multi-chunk write", async () => {
    const store = await makeStore();
    const input = makeBytes(CHUNK_SIZE * 3);
    const address = await shaFor(input);
    await store.installChunkWriteFailure(1);

    await expect(store.writeObject(input)).rejects.toThrow("interrupted chunk write");

    expect(await store.readObject(address)).toBeUndefined();
    expect(await store.listObjects()).toHaveLength(0);
    expect(await store.countChunkRows()).toBe(0);
  });

  it("deletes every chunk of a multi-chunk object", async () => {
    const store = await makeStore();
    const input = makeBytes(CHUNK_SIZE * 2 + 1);
    const address = await store.writeObject(input);

    expect(await store.listObjects()).toEqual([address]);
    expect(await store.countChunkRows()).toBe(3);

    await store.deleteObject(address);

    expect(await store.readObject(address)).toBeUndefined();
    expect(await store.listObjects()).toHaveLength(0);
    expect(await store.countChunkRows()).toBe(0);
  });

  it("does not duplicate chunks when rewriting identical large content", async () => {
    const store = await makeStore();
    const input = makeBytes(CHUNK_SIZE * 2 + 1);

    const firstAddress = await store.writeObject(input);
    const secondAddress = await store.writeObject(input);

    expect(secondAddress).toBe(firstAddress);
    expect(await store.listObjects()).toHaveLength(1);
    expect(await store.countChunkRows()).toBe(3);
  });
});
