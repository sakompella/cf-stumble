import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

type Lock = { readonly semaphore: Semaphore.Semaphore; users: number };

export class KeyedLock<K> {
  readonly #locks = new Map<K, Lock>();

  withLock<A, E, R>(key: K, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.#enter(key)),
      (lock) => lock.semaphore.withPermit(effect),
      (lock) =>
        Effect.sync(() => {
          lock.users -= 1;

          if (lock.users === 0 && this.#locks.get(key) === lock) this.#locks.delete(key);
        }),
    );
  }

  busy(key: K): boolean {
    return this.#locks.has(key);
  }

  #enter(key: K): Lock {
    const lock = this.#locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };

    lock.users += 1;
    this.#locks.set(key, lock);

    return lock;
  }
}
