import { panic, Result, type Result as ResultType } from "better-result";
import { buildGeneration, type GenerationBuildError } from "./build.js";
import type { BuildGenerationOptions } from "./build.js";
import { walkLineage } from "./lineage.js";
import { isSha } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type { StorageCapacityError, StorageUnavailableError } from "../storage/errors.js";
import type { PointerStore, Store } from "../storage/types.js";
import type { CommitSnapshot } from "./types.js";

export type GenesisOptions = Omit<BuildGenerationOptions, "parent"> & {
  readonly parent?: undefined;
};

/** Options for seeding the root when its pointer claim must be part of a larger transaction. */
export type GenesisSeedOptions = {
  /** Defaults to true; false leaves the pointer claim to the caller. */
  readonly claimPointer?: boolean;
};

/** Durable root commit identity passed to reset and reachability checks. */
export type GenesisPin = {
  readonly kind: "genesis";
  readonly sha: Sha;
};

export type ResetResult =
  | { readonly outcome: "reset"; readonly from: Sha | undefined; readonly to: Sha }
  | { readonly outcome: "contended"; readonly attempts: number };

export type GenesisSeedError =
  | GenerationBuildError
  | StorageUnavailableError
  | StorageCapacityError;

/**
 * Reset re-reads and retries on a lost CAS, but a promotion storm must not be able to spin it
 * forever: this runs inside a Durable Object, so an unbounded loop wedges the request rather
 * than failing it, and the escape hatch becomes unobservably stuck exactly when it is needed.
 * Bounded attempts turn that into a reportable outcome the caller can escalate.
 */
export const MAX_RESET_ATTEMPTS = 16;

/** Build the pinned genesis commit and claim the live pointer when it is uninitialized. */
export async function seedGenesis(
  store: Store,
  options: GenesisOptions,
  seedOptions: GenesisSeedOptions = {},
): Promise<ResultType<CommitSnapshot, GenesisSeedError>> {
  const built = await buildGeneration(store, { ...options, parent: undefined });
  if (Result.isError(built)) {
    return built;
  }
  const genesis = built.value;
  if (seedOptions.claimPointer !== false) {
    const current = await store.readPointer();
    if (Result.isError(current)) {
      return current;
    }
    if (current.value === undefined) {
      const claimed = await store.setPointer(genesis.sha, undefined);
      if (Result.isError(claimed)) {
        return claimed;
      }
    }
  }
  return Result.ok(genesis);
}

/** Return whether a commit snapshot is a root with no parent. */
export function isGenesisCommit(commit: Pick<CommitSnapshot, "parent">): boolean {
  return commit.parent === undefined;
}

/** Turn a root commit snapshot into explicit identity for recovery and reachability checks. */
export function makeGenesisPin(commit: CommitSnapshot): GenesisPin {
  if (!isGenesisCommit(commit)) {
    panic("only a root commit without a parent can be pinned as genesis");
  }
  return { kind: "genesis", sha: commit.sha };
}

/** Identify a sha by comparing it with the explicit genesis root data. */
export function isGenesisSha(sha: Sha, pin: GenesisPin): boolean {
  return pin.kind === "genesis" && pin.sha === sha;
}

export function isGenesis(commit: Pick<CommitSnapshot, "parent">): boolean;
export function isGenesis(sha: Sha, pin: GenesisPin): boolean;
export function isGenesis(value: Pick<CommitSnapshot, "parent"> | Sha, pin?: GenesisPin): boolean {
  if (isShaValue(value)) {
    return pin !== undefined && isGenesisSha(value, pin);
  }
  return isGenesisCommit(value);
}

function isShaValue(value: Pick<CommitSnapshot, "parent"> | Sha): value is Sha {
  return typeof value === "string" && isSha(value);
}

export async function assertGenesisReachable(
  store: Store,
  start: Sha,
  pin: GenesisPin,
): Promise<ResultType<void, StorageUnavailableError>> {
  const lineage = await walkLineage(store, start);
  if (Result.isError(lineage)) {
    return lineage;
  }
  const root = lineage.value.at(-1);
  if (root === undefined || !isGenesisSha(root.sha, pin)) {
    panic(`commit ${start} does not reach pinned genesis ${pin.sha}`);
  }
  return Result.ok();
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
): Promise<ResultType<ResetResult, StorageUnavailableError | StorageCapacityError>> {
  for (let attempt = 1; attempt <= MAX_RESET_ATTEMPTS; attempt += 1) {
    const from = await store.readPointer();
    if (Result.isError(from)) {
      return from;
    }
    const swapped = await store.setPointer(pin.sha, from.value);
    if (Result.isError(swapped)) {
      return swapped;
    }
    const result = resetAttempt(attempt, from.value, swapped.value, pin.sha);
    if (result !== undefined) {
      return Result.ok(result);
    }
  }
  return Result.ok({ outcome: "contended", attempts: MAX_RESET_ATTEMPTS });
}

/**
 * Synchronous reset for a caller that needs pointer and side-row writes in one transaction.
 * The caller owns the transaction; the same bounded CAS semantics apply inside it.
 */
export function resetToGenesisSync(store: SynchronousPointerStore, pin: GenesisPin): ResetResult {
  for (let attempt = 1; attempt <= MAX_RESET_ATTEMPTS; attempt += 1) {
    const from = store.readPointer();
    const result = resetAttempt(attempt, from, store.setPointer(pin.sha, from), pin.sha);
    if (result !== undefined) {
      return result;
    }
  }
  return { outcome: "contended", attempts: MAX_RESET_ATTEMPTS };
}
