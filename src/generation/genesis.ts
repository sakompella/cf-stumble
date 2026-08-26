import { buildGeneration } from "./build.js";
import type { BuildGenerationOptions } from "./build.js";
import type { Sha } from "../git/types.js";
import type { PointerStore, Store } from "../storage/types.js";
import { GENESIS_NUMBER } from "./types.js";
import type { Generation } from "./types.js";

export type GenesisOptions = Omit<BuildGenerationOptions, "parent"> & {
  readonly parent?: undefined;
};

/** Durable root identity passed to reset and future reachability-based garbage collection. */
export type GenesisPin = {
  readonly kind: "genesis";
  readonly sha: Sha;
  readonly number: typeof GENESIS_NUMBER;
};

export type ResetResult = {
  readonly outcome: "reset";
  readonly from: Sha | undefined;
  readonly to: Sha;
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

/** Return whether a generation record describes the pinned generation 0 shape. */
export function isGenesisGeneration(
  generation: Pick<Generation, "number" | "parent">,
): boolean {
  return generation.number === GENESIS_NUMBER && generation.parent === undefined;
}

/** Turn a validated generation-0 record into explicit root data for recovery and GC. */
export function makeGenesisPin(generation: Generation): GenesisPin {
  if (!isGenesisGeneration(generation)) {
    throw new TypeError("only generation 0 without a parent can be pinned as genesis");
  }
  return { kind: "genesis", sha: generation.sha, number: GENESIS_NUMBER };
}

/** Identify a sha by comparing it with the explicit genesis root data. */
export function isGenesisSha(sha: Sha, pin: GenesisPin): boolean {
  return pin.kind === "genesis" && pin.number === GENESIS_NUMBER && pin.sha === sha;
}

export function isGenesis(
  generation: Pick<Generation, "number" | "parent">,
): boolean;
export function isGenesis(sha: Sha, pin: GenesisPin): boolean;
export function isGenesis(
  value: Pick<Generation, "number" | "parent"> | Sha,
  pin?: GenesisPin,
): boolean {
  if (typeof value === "string") {
    return pin !== undefined && isGenesisSha(value, pin);
  }
  return isGenesisGeneration(value);
}

/** Reset through the pointer store only, retrying CAS if a concurrent writer wins a race. */
export async function resetToGenesis(
  store: PointerStore,
  pin: GenesisPin,
): Promise<ResetResult> {
  while (true) {
    const from = await store.readPointer();
    if (await store.setPointer(pin.sha, from)) {
      return { outcome: "reset", from, to: pin.sha };
    }
  }
}
