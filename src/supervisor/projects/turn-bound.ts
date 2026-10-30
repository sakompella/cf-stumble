import * as Effect from "effect/Effect";

/**
 * The budget is kept as an instant, not a duration, because a duration can be applied twice:
 * measured against the start and again against the stream, a turn could outlive its lease and keep
 * editing the shared workspace after a replacement turn was admitted.
 */
export class TurnBound {
  readonly endsAt: number;
  readonly #now: () => number;
  readonly #cancellation = new AbortController();

  /** Clamped to the lease, so a turn may not outlive the admission that granted it the project. */
  static forTurn(
    admittedAt: number,
    leaseMs: number,
    deadlineMs: number,
    now: () => number,
  ): TurnBound {
    return new TurnBound(admittedAt + Math.min(leaseMs, deadlineMs), now);
  }

  constructor(endsAt: number, now: () => number) {
    this.endsAt = endsAt;
    this.#now = now;
  }

  get signal(): AbortSignal {
    return this.#cancellation.signal;
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - this.#now());
  }

  /** A phase that starts late gets only what earlier phases left. */
  within<A, E, R, B>(work: Effect.Effect<A, E, R>, expired: B): Effect.Effect<A | B, E, R> {
    const expiry = Effect.suspend(() => Effect.sleep(this.remainingMs())).pipe(
      Effect.map(() => {
        this.stop();

        return expired;
      }),
    );

    return Effect.raceFirst(work, expiry);
  }

  /**
   * A turn that ended early releases its lease at once, so nothing may still be running under it.
   */
  stop(): void {
    this.#cancellation.abort();
  }
}
