import { Result } from "better-result";
import type { Sha } from "../git/types.js";
import type { PointerStore } from "../storage/types.js";

export type PinnedTurn<T> = {
  readonly generation: Sha;
  readonly result: T;
};

/** Resolve the live generation once, then keep that identity for the whole turn. */
export async function runPinnedTurn<T>(
  pointerStore: PointerStore,
  execute: (generation: Sha) => Promise<T>,
): Promise<PinnedTurn<T>> {
  const pointer = await pointerStore.readPointer();
  if (Result.isError(pointer)) {
    throw pointer.error;
  }
  if (pointer.value === undefined) {
    throw new Error("cannot start a turn without a live generation");
  }
  return { generation: pointer.value, result: await execute(pointer.value) };
}
