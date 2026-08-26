/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach } from "vitest";
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
