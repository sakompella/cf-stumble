/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { describeStoreConformance } from "../../src/storage/conformance.js";
import { DurableObjectSqliteStore } from "../../src/storage/do-sqlite.js";
import type { SweepableStore } from "../../src/storage/types.js";

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
}

function makeStore(): Promise<SweepableStore> {
  const name = `storage-conformance-${crypto.randomUUID()}`;
  return Promise.resolve(new TestStore(env.SUPERVISOR.getByName(name)));
}

afterEach(async () => {
  await reset();
});

describeStoreConformance("DurableObjectSqliteStore", makeStore);

describe("DurableObjectSqliteStore chunking", () => {
  it("round-trips an object larger than the single-row limit", async () => {
    const store = await makeStore();
    const input = new Uint8Array(4 * 1024 * 1024);
    for (let index = 0; index < input.length; index += 1) {
      input[index] = index % 251;
    }

    const address = await store.writeObject(input);

    expect(await store.readObject(address)).toEqual(input);
  });
});
