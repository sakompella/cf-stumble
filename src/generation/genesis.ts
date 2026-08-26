import { buildGeneration } from "./build.js";
import type { BuildGenerationOptions } from "./build.js";
import { walkLineage } from "./lineage.js";
import { isSha } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type { PointerStore, Store } from "../storage/types.js";
import { GENESIS_NUMBER } from "./types.js";
import type { Generation } from "./types.js";

export type GenesisOptions = Omit<BuildGenerationOptions, "parent"> & {
  readonly parent?: undefined;
};

/** Options for seeding the root when its pointer claim must be part of a larger transaction. */
export type GenesisSeedOptions = {
  /** Defaults to true; false leaves the pointer claim to the caller. */
  readonly claimPointer?: boolean;
};

/** Durable root identity passed to reset and future reachability-based garbage collection. */
export type GenesisPin = {
  readonly kind: "genesis";
  readonly sha: Sha;
  readonly number: typeof GENESIS_NUMBER;
};

export type ResetResult =
  | { readonly outcome: "reset"; readonly from: Sha | undefined; readonly to: Sha }
  | { readonly outcome: "contended"; readonly attempts: number };

/**
 * Reset re-reads and retries on a lost CAS, but a promotion storm must not be able to spin it
 * forever: this runs inside a Durable Object, so an unbounded loop wedges the request rather
 * than failing it, and the escape hatch becomes unobservably stuck exactly when it is needed.
 * Bounded attempts turn that into a reportable outcome the caller can escalate.
 */
export const MAX_RESET_ATTEMPTS = 16;

/** Build generation 0 and claim the live pointer when it has not been initialized. */
export async function seedGenesis(
  store: Store,
  options: GenesisOptions,
  seedOptions: GenesisSeedOptions = {},
): Promise<Generation> {
  const genesis = await buildGeneration(store, { ...options, parent: undefined });
  if (seedOptions.claimPointer !== false) {
    const current = await store.readPointer();
    if (current === undefined) {
      await store.setPointer(genesis.sha, undefined);
    }
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
  if (isShaValue(value)) {
    return pin !== undefined && isGenesisSha(value, pin);
  }
  return isGenesisGeneration(value);
}

function isShaValue(
  value: Pick<Generation, "number" | "parent"> | Sha,
): value is Sha {
  return typeof value === "string" && isSha(value);
}

export async function assertGenesisReachable(
  store: Store,
  start: Sha,
  pin: GenesisPin,
): Promise<void> {
  const lineage = await walkLineage(store, start);
  const root = lineage.at(-1);
  if (root === undefined || !isGenesisSha(root.sha, pin)) {
    throw new Error(`generation ${start} does not reach pinned genesis ${pin.sha}`);
  }
}

/** A synchronous pointer store used when a reset must share a SQLite transaction with side rows. */
export type SynchronousPointerStore = {
  readonly readPointer: () => Sha | undefined;
  readonly setPointer: (next: Sha, expected: Sha | undefined) => boolean;
};

function resetAttempt(
  attempt: number,
  from: Sha | undefined,
  swapped: boolean,
  to: Sha,
): ResetResult | undefined {
  if (swapped) {
    return { outcome: "reset", from, to };
  }
  if (attempt === MAX_RESET_ATTEMPTS) {
    return { outcome: "contended", attempts: MAX_RESET_ATTEMPTS };
  }
  return undefined;
}

/** Reset through the pointer store only, retrying CAS if a concurrent writer wins a race. */
export async function resetToGenesis(
  store: PointerStore,
  pin: GenesisPin,
): Promise<ResetResult> {
  for (let attempt = 1; attempt <= MAX_RESET_ATTEMPTS; attempt += 1) {
    const from = await store.readPointer();
    const result = resetAttempt(attempt, from, await store.setPointer(pin.sha, from), pin.sha);
    if (result !== undefined) {
      return result;
    }
  }
  return { outcome: "contended", attempts: MAX_RESET_ATTEMPTS };
}

/**
 * Synchronous reset for a caller that needs pointer and side-row writes in one transaction.
 * The caller owns the transaction; the same bounded CAS semantics apply inside it.
 */
export function resetToGenesisSync(
  store: SynchronousPointerStore,
  pin: GenesisPin,
): ResetResult {
  for (let attempt = 1; attempt <= MAX_RESET_ATTEMPTS; attempt += 1) {
    const from = store.readPointer();
    const result = resetAttempt(attempt, from, store.setPointer(pin.sha, from), pin.sha);
    if (result !== undefined) {
      return result;
    }
  }
  return { outcome: "contended", attempts: MAX_RESET_ATTEMPTS };
}
