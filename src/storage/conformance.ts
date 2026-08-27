import { describe, expect, it } from "vitest";
import { Result } from "better-result";
import { parseSha } from "../git/types.js";
import type { Sha } from "../git/types.js";
import { MAX_OBJECT_BYTES, ObjectTooLargeError, type SweepableStore } from "./types.js";

const EMPTY_SHA = parseSha("da39a3ee5e6b4b0d3255bfef95601890afd80709");
const BYTES_SHA = parseSha("c62c27924f4c967f5eddb1850c091d54c7a2ab58");
const UNKNOWN_SHA = parseSha("0000000000000000000000000000000000000000");
const POINTER_BASE = parseSha("1111111111111111111111111111111111111111");
const POINTER_NEXT = parseSha("2222222222222222222222222222222222222222");
const POINTER_OTHER = parseSha("3333333333333333333333333333333333333333");

type StoreFactory = () => Promise<SweepableStore>;

async function writeObject(store: SweepableStore, bytes: Uint8Array): Promise<Sha> {
  const result = await store.writeObject(bytes);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
}

function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrived += 1;
    if (arrived === parties) {
      release();
    }
    await allArrived;
  };
}

function testContentAddressing(makeStore: StoreFactory): void {
  it("content-addresses exact bytes", async () => {
    const store = await makeStore();
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const sameBytes = new Uint8Array([0, 1, 2, 255]);
    const differentBytes = new Uint8Array([0, 1, 2, 254]);

    const address = await writeObject(store, bytes);
    const sameAddress = await writeObject(store, sameBytes);
    const differentAddress = await writeObject(store, differentBytes);

    expect(address).toBe(BYTES_SHA);
    expect(address).toMatch(/^[0-9a-f]{40}$/u);
    expect(sameAddress).toBe(address);
    expect(differentAddress).not.toBe(address);
  });
}

function testIdempotentWrites(makeStore: StoreFactory): void {
  it("makes repeated writes idempotent", async () => {
    const store = await makeStore();
    const bytes = new Uint8Array([10, 20, 30]);

    const firstAddress = await writeObject(store, bytes);
    const secondAddress = await writeObject(store, bytes);

    expect(secondAddress).toBe(firstAddress);
    expect(await store.listObjects()).toHaveLength(1);
  });
}

function testUnknownReads(makeStore: StoreFactory): void {
  it("returns undefined for an unknown object", async () => {
    const store = await makeStore();

    expect(await store.readObject(UNKNOWN_SHA)).toBeUndefined();
  });
}

function testByteFidelity(makeStore: StoreFactory): void {
  it("preserves bytes across round-trips", async () => {
    const store = await makeStore();
    const large = new Uint8Array(1024 * 1024);
    for (let index = 0; index < large.length; index += 1) {
      large[index] = index % 251;
    }
    const inputs = [new Uint8Array(), new Uint8Array([0, 255, 0, 1]), large];

    for (const input of inputs) {
      const address = await writeObject(store, input);
      const output = await store.readObject(address);

      expect(output).toEqual(input);
    }

    expect(await writeObject(store, new Uint8Array())).toBe(EMPTY_SHA);
  });
}

function testBufferIsolation(makeStore: StoreFactory): void {
  it("does not retain caller-owned byte arrays", async () => {
    const store = await makeStore();
    const input = new Uint8Array([1, 2, 3]);
    const address = await writeObject(store, input);
    input[0] = 99;

    const firstRead = await store.readObject(address);
    expect(firstRead).toEqual(new Uint8Array([1, 2, 3]));
    if (firstRead === undefined) {
      throw new Error("stored object was unexpectedly missing");
    }
    firstRead[1] = 88;

    expect(await store.readObject(address)).toEqual(new Uint8Array([1, 2, 3]));
  });
}

function testPointerCas(makeStore: StoreFactory): void {
  it("performs pointer compare-and-swap without stale writes", async () => {
    const store = await makeStore();

    expect(await store.readPointer()).toBeUndefined();
    expect(await store.setPointer(POINTER_NEXT, undefined)).toBe(true);
    expect(await store.readPointer()).toBe(POINTER_NEXT);

    expect(await store.setPointer(POINTER_OTHER, undefined)).toBe(false);
    expect(await store.readPointer()).toBe(POINTER_NEXT);

    expect(await store.setPointer(POINTER_OTHER, POINTER_BASE)).toBe(false);
    expect(await store.readPointer()).toBe(POINTER_NEXT);

    expect(await store.setPointer(POINTER_OTHER, POINTER_NEXT)).toBe(true);
    expect(await store.readPointer()).toBe(POINTER_OTHER);
  });
}

function testConcurrentPointerCas(makeStore: StoreFactory): void {
  it("allows exactly one concurrent promotion from the same base", async () => {
    const store = await makeStore();
    const contenderCount = 16;
    const contenders = Array.from({ length: contenderCount }, (_, index) =>
      parseSha(String(index + 10).padStart(40, "0")),
    );
    const waitForContenders = makeBarrier(contenderCount);

    expect(await store.setPointer(POINTER_BASE, undefined)).toBe(true);
    const attempts = contenders.map(async (next) => {
      await waitForContenders();
      return { next, won: await store.setPointer(next, POINTER_BASE) };
    });
    const results = await Promise.all(attempts);
    const winners = results.filter(({ won }) => won).map(({ next }) => next);

    expect(winners).toHaveLength(1);
    expect(await store.readPointer()).toBe(winners[0]);
  });
}

function testSweep(makeStore: StoreFactory): void {
  it("sweeps objects and tolerates missing deletes", async () => {
    const store = await makeStore();
    const retained = await writeObject(store, new Uint8Array([1]));
    const removed = await writeObject(store, new Uint8Array([2]));

    expect(await store.listObjects()).toHaveLength(2);
    await store.deleteObject(removed);

    expect(await store.readObject(removed)).toBeUndefined();
    expect(await store.listObjects()).toEqual(expect.arrayContaining([retained]));
    expect(await store.listObjects()).not.toContain(removed);
    await store.deleteObject(removed);
  });
}

function testObjectSizeLimit(makeStore: StoreFactory): void {
  it("returns an ObjectTooLargeError for an object above the shared limit", async () => {
    const store = await makeStore();
    const bytes = new Uint8Array();
    Object.defineProperty(bytes, "byteLength", { value: MAX_OBJECT_BYTES + 1 });

    const result = await store.writeObject(bytes);

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected object above the size limit to be rejected");
    }
    expect(ObjectTooLargeError.is(result.error)).toBe(true);
    expect(result.error).toMatchObject({
      actualBytes: MAX_OBJECT_BYTES + 1,
      maxBytes: MAX_OBJECT_BYTES,
    });
  });
}

export function describeStoreConformance(name: string, makeStore: StoreFactory): void {
  describe(`${name} store`, () => {
    testContentAddressing(makeStore);
    testIdempotentWrites(makeStore);
    testUnknownReads(makeStore);
    testByteFidelity(makeStore);
    testBufferIsolation(makeStore);
    testPointerCas(makeStore);
    testConcurrentPointerCas(makeStore);
    testSweep(makeStore);
    testObjectSizeLimit(makeStore);
  });
}
