import { buildGeneration } from "./build.js";
import type { BuildGenerationOptions } from "./build.js";
import type { Store } from "../storage/types.js";
import type { Generation } from "./types.js";

export type GenesisOptions = Omit<BuildGenerationOptions, "parent"> & {
  readonly parent?: undefined;
};

/** Build generation 0 and claim the live pointer when it has not been initialized. */
export async function seedGenesis(
  store: Store,
  options: GenesisOptions,
): Promise<Generation> {
  const genesis = await buildGeneration(store, { ...options, parent: undefined });
  const current = await store.readPointer();
  if (current === undefined) {
    await store.setPointer(genesis.sha, undefined);
  }
  return genesis;
}
