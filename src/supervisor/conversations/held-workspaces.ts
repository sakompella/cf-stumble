import type * as Effect from "effect/Effect";
import { runAtEntryPoint } from "../../run-entry-point.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import type { SelectableProject } from "../../selectable-projects.js";
import type { ProjectCapabilityStub } from "../../workspace/index.js";

export type ObtainWorkspace = (
  project: SelectableProject,
  remainingMs: number,
  signal: AbortSignal,
) => Effect.Effect<ProjectCapabilityStub | null>;

type HeldWorkspace = Readonly<{
  capability: Promise<ProjectCapabilityStub | null>;
  release: AbortController;
}>;

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
    const controller = new AbortController();
    const capability = runAtEntryPoint(this.#obtain(project, remainingMs, controller.signal));
    const held = { capability, release: controller };

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
  held.release.abort();
  void held.capability.then((capability) => {
    if (capability !== null) endWorkspaceTurn(capability);
  });
}

export function endWorkspaceTurn(capability: ProjectCapabilityStub): void {
  const dispose = () => {
    capability[Symbol.dispose]();
  };

  void capability.endTurn().then(dispose, dispose);
}
