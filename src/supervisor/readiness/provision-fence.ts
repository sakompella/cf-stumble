import * as Effect from "effect/Effect";
import { KeyedLock } from "../../keyed-lock.js";
import type { ProjectId } from "../../project-catalog.js";

export class ProvisionFence {
  #locks = new KeyedLock<ProjectId>();

  provision<A, E>(projectId: ProjectId, run: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => this.#locks.withLock(projectId, run));
  }

  wait(projectId: ProjectId): Effect.Effect<void> {
    return this.provision(projectId, Effect.void);
  }

  clear(): void {
    this.#locks = new KeyedLock<ProjectId>();
  }
}
