import * as Effect from "effect/Effect";
import type { ProjectId } from "../../project-catalog.js";

export class ProjectLifecycleQueue {
  private readonly tails = new Map<ProjectId, Promise<void>>();

  exclusive<A, E>(projectId: ProjectId, operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      const previous = this.tails.get(projectId) ?? Promise.resolve();
      const finished = { settle: (): void => {} };

      const own = new Promise<void>((resolve) => {
        finished.settle = resolve;
      });

      const settled = previous.then(() => own);
      this.tails.set(projectId, settled);
      void settled.then(() => {
        if (this.tails.get(projectId) === settled) this.tails.delete(projectId);
      });

      return Effect.promise(() => previous).pipe(
        Effect.andThen(operation),
        Effect.ensuring(
          Effect.sync(() => {
            finished.settle();
          }),
        ),
      );
    });
  }
}
