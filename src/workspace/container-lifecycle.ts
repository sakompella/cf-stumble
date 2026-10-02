/**
 * What the Workspace Host knows about which container run its clients are talking to. A project
 * capability remembers the generation it was handed out at, and an exec that finds a newer one
 * reports `container-restarted` instead of running on a replaced container.
 */
export class ContainerLifecycle {
  generation = 0;
  #hasConnected = false;
  #runtimeId: string | undefined;

  /** A backend connect completed. Reaching a different runtime than before is a replacement. */
  connected(runtimeId: string | undefined): void {
    if (this.#hasConnected && this.#runtimeId !== runtimeId) this.generation += 1;

    this.#hasConnected = true;
    this.#runtimeId = runtimeId;
  }

  /** A status read showed the container was replaced or gone. */
  replaced(): void {
    this.generation += 1;
  }

  /**
   * The Host stopped the container on purpose while nothing used it. The next connect reaches a
   * fresh runtime that nobody holds a capability for, so it is not a replacement to report.
   */
  stoppedByHost(): void {
    this.#hasConnected = false;
  }
}
