import * as Effect from "effect/Effect";
import type { ProjectId } from "../../project-catalog.js";

/**
 * Runs lifecycle operations for one project id one after another: connecting, disconnecting with
 * its workspace removal, and provisioning on use.
 *
 * Each of those awaits the Workspace Host, and a Durable Object delivers other requests while it
 * waits. Without this queue a reconnect could clone while an earlier disconnect was still removing
 * the same fixed directory, and a failed connection could delete the row that an overlapping
 * connection had just provisioned. Operations on different projects do not wait for each other.
 *
 * The queue lives in this Supervisor instance only. If the platform replaces the instance, an
 * operation that the old instance started may still be running inside the Workspace Host, and a
 * Workspace Host RPC that timed out may still be running a command there too.
 */
export class ProjectLifecycleQueue {
  private readonly tails = new Map<ProjectId, Promise<void>>();

  /**
   * Run `operation` after every earlier operation for `projectId` has settled. Its place in the
   * queue is taken when this Effect starts, which is the order callers asked in.
   *
   * A caller interrupted while it waits gives up its turn and never runs. Once `operation` has
   * started it runs to the end without interruption, because its Workspace Host calls cannot be
   * recalled: the next operation waits for that work, not only for the caller that stopped
   * waiting. The tails are native Promises, so no request's fiber resumes another's.
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
