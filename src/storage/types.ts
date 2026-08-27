/**
 * The storage surface, deliberately kept to four functions (ADR-0009, ADR-0003).
 *
 * Cloudflare Artifacts is expected to replace the implementation later, so the interface is
 * shaped like what Artifacts offers — a content-addressed map from hash to bytes — rather
 * than like anything git-specific. The store never parses what it holds.
 */

import type { Sha } from "../git/types.js";

export interface ObjectStore {
  /** Returns undefined for an address that was never written. */
  readObject(sha: Sha): Promise<Uint8Array | undefined>;

  /**
   * Stores the complete git object bytes, header included, and returns the SHA-1 of exactly
   * those bytes. Writing content that is already present is a no-op that returns the same
   * address, which is what makes an unchanged module across generations cost nothing.
   */
  writeObject(bytes: Uint8Array): Promise<Sha>;
}

export interface PointerStore {
  /** The live generation, or undefined before anything has been promoted. */
  readPointer(): Promise<Sha | undefined>;

  /**
   * Compare-and-swap. Returns false without writing when the current pointer is not
   * `expected`, so two concurrent promotions from the same base cannot both win.
   * `expected` is undefined only when claiming the pointer for the first time.
   */
  setPointer(next: Sha, expected: Sha | undefined): Promise<boolean>;
}

export interface Store extends ObjectStore, PointerStore {}

/**
 * Garbage collection needs to enumerate and delete, which the four-function surface
 * deliberately does not expose. It is a separate capability rather than two more core
 * functions, because Artifacts may well not offer it and only the GC path should care.
 */
export interface SweepableStore extends Store {
  listObjects(): Promise<readonly Sha[]>;
  deleteObject(sha: Sha): Promise<void>;
}
