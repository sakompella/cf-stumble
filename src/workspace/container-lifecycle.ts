export class ContainerLifecycle {
  generation = 0;
  #hasConnected = false;
  #runtimeId: string | undefined;

  connected(runtimeId: string | undefined): void {
    if (this.#hasConnected && this.#runtimeId !== runtimeId) this.generation += 1;

    this.#hasConnected = true;
    this.#runtimeId = runtimeId;
  }

  stoppedByHost(): void {
    this.#hasConnected = false;
  }
}
