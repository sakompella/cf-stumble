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
  const generation = await pointerStore.readPointer();
  if (generation === undefined) {
    throw new Error("cannot start a turn without a live generation");
  }
  return { generation, result: await execute(generation) };
}
