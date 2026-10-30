/** A capability remembers the generation it was handed out at; an exec that finds a newer one reports `container-restarted`. */
export class ContainerLifecycle {
  generation = 0;
  #hasConnected = false;
  #runtimeId: string | undefined;

  connected(runtimeId: string | undefined): void {
    if (this.#hasConnected && this.#runtimeId !== runtimeId) this.generation += 1;

    this.#hasConnected = true;
    this.#runtimeId = runtimeId;
  }

  /** Stopped on purpose while idle. The next connect reaches a runtime nobody holds a capability for, so it is not a replacement. */
  stoppedByHost(): void {
    this.#hasConnected = false;
  }
}
