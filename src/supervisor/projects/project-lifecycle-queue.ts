import * as Effect from "effect/Effect";
import type { ProjectId } from "../../project-catalog.js";

/**
 * A Durable Object delivers other requests while it awaits the Workspace Host, so without this
 * queue a reconnect could clone while a disconnect is still removing the same directory. The queue
 * lives in this instance only; a replaced instance's operations may still be running in the
 * Workspace Host.
 */
export class ProjectLifecycleQueue {
  private readonly tails = new Map<ProjectId, Promise<void>>();

  /**
   * A caller interrupted while waiting never runs. Once started, `operation` runs to the end,
   * because its Workspace Host calls cannot be recalled.
   */
  exclusive<A, E>(projectId: ProjectId, operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      const previous = this.tails.get(projectId) ?? Promise.resolve();
      const finished = { settle: (): void => {} };

      const own = new Promise<void>((resolve) => {
        finished.settle = resolve;
      });

      // Settled after every earlier operation and this one, even if this one never ran.
      const settled = previous.then(() => own);
      this.tails.set(projectId, settled);
      void settled.then(() => {
        if (this.tails.get(projectId) === settled) this.tails.delete(projectId);
      });

      return Effect.promise(() => previous).pipe(
        Effect.andThen(Effect.uninterruptible(operation)),
        Effect.ensuring(
          Effect.sync(() => {
            finished.settle();
          }),
        ),
      );
    });
  }
}
