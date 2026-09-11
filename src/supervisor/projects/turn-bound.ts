/**
 * One turn's single lifetime, as one instant.
 *
 * A turn is admitted once, and everything it then does — mounting the generation that serves,
 * reconciling the workspace, asking a facet to begin, and reading the frames it writes — is spent
 * out of the one budget that admission opened. The budget is kept as the instant it ends rather
 * than as a duration, because a duration can be applied twice: the fault this replaces measured
 * the same four minutes once against the start and again against the stream, so a turn could run
 * for eight minutes under a five-minute lease and go on editing the tenant's one shared workspace
 * (ADR-0038) while a replacement turn was already admitted.
 *
 * The instant carries one cancellation signal. Whatever ends the turn first — the bound passing,
 * the browser disconnecting, or a start that lost its race — aborts that one signal, so the work
 * behind the turn is cancelled rather than merely ignored.
 */
export class TurnBound {
  /** The instant this turn ends, on the clock the lease was taken with. */
  readonly endsAt: number;
  readonly #now: () => number;
  readonly #cancellation = new AbortController();
  readonly #expiry: Promise<"timed-out">;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timedOut = false;

  /**
   * The bound of a turn admitted at `admittedAt` under a lease of `leaseMs`, which may wait
   * `deadlineMs` for the generation. The turn's lifetime is the deadline, and it is clamped to the
   * lease: a turn may not outlive the admission that granted it the project, whatever the two
   * numbers are set to.
   */
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
    this.#expiry = new Promise((resolve) => {
      this.#timer = setTimeout(() => {
        this.#timedOut = true;
        this.#cancellation.abort();
        resolve("timed-out");
      }, this.remainingMs());
    });
  }

  /** The turn's cancellation. Every step of the turn is passed this one signal. */
  get signal(): AbortSignal {
    return this.#cancellation.signal;
  }

  /** What is left of the turn's budget, which is what any remaining step may take. */
  remainingMs(): number {
    return Math.max(0, this.endsAt - this.#now());
  }

  /** Whether the turn ran out of time, as opposed to being stopped by something else. */
  timedOut(): boolean {
    return this.#timedOut;
  }

  /** Resolves when the turn's time is up, so a step can race its own work against the bound. */
  whenTimedOut(): Promise<"timed-out"> {
    return this.#expiry;
  }

  /**
   * End the turn now: the signal is aborted, and the timer that would have aborted it is dropped.
   * A turn that ended early releases its lease at once, so nothing may still be running under it.
   */
  stop(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    this.#cancellation.abort();
  }
}
