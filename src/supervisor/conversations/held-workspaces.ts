import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { runAtEntryPoint } from "../../run-entry-point.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import type { SelectableProject } from "../../selectable-projects.js";
import type { ProjectCapabilityStub } from "../../workspace/index.js";

export type ScopedWorkspace = Effect.Effect<ProjectCapabilityStub | null, never, Scope.Scope>;

export type ObtainWorkspace = (project: SelectableProject, remainingMs: number) => ScopedWorkspace;

type HeldWorkspace = Readonly<{
  capability: Promise<ProjectCapabilityStub | null>;
  scope: Scope.Closeable;
}>;

function holdWorkspace(scope: Scope.Scope, obtain: ScopedWorkspace) {
  return runAtEntryPoint(
    Effect.forkIn(Scope.provide(obtain, scope), scope).pipe(
      Effect.flatMap(Fiber.await),
      Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : null)),
    ),
  );
}

export function heldWorkspace(obtain: ScopedWorkspace) {
  const scope = Scope.makeUnsafe();
  let capability: Promise<ProjectCapabilityStub | null> | undefined;

  return {
    capability: () => (capability ??= holdWorkspace(scope, obtain)),
    release: Effect.forkDetach(Scope.close(scope, Exit.void)),
  };
}

export class HeldWorkspaces {
  readonly #obtain: ObtainWorkspace;
  readonly #held = new Map<string, HeldWorkspace>();
  #retirement: (() => void) | undefined;

  constructor(obtain: ObtainWorkspace) {
    this.#obtain = obtain;
  }

  async capability(
    conversationId: string,
    project: SelectableProject,
    remainingMs: number,
  ): Promise<ProjectRpcTargetContract & Disposable> {
    const held = this.#held.get(conversationId) ?? this.#hold(conversationId, project, remainingMs);
    const capability = await held.capability;

    if (capability === null) throw new Error("the workspace is unavailable");

    return capability.dup();
  }

  end(conversationId: string): void {
    const held = this.#held.get(conversationId);

    if (held === undefined) return;

    this.#held.delete(conversationId);
    release(held);
  }

  endAll(): void {
    this.#detach()();
  }

  retire(alsoRetire: () => void): void {
    this.flushRetirement();

    const ending = this.#detach();

    const once = () => {
      if (this.#retirement !== once) return;

      this.#retirement = undefined;
      alsoRetire();
      ending();
    };

    this.#retirement = once;
    setTimeout(once, 0);
  }

  flushRetirement(): void {
    this.#retirement?.();
  }

  #detach(): () => void {
    const detached = [...this.#held.values()];

    this.#held.clear();

    return () => {
      for (const held of detached) release(held);
    };
  }

  #hold(conversationId: string, project: SelectableProject, remainingMs: number): HeldWorkspace {
    const scope = Scope.makeUnsafe();
    const capability = holdWorkspace(scope, this.#obtain(project, remainingMs));
    const held = { capability, scope };

    this.#held.set(conversationId, held);
    void capability.then((obtained) => {
      if (obtained === null && this.#held.get(conversationId) === held) {
        this.#held.delete(conversationId);
      }
    });

    return held;
  }
}

function release(held: HeldWorkspace): void {
  void runAtEntryPoint(Scope.close(held.scope, Exit.void));
}
