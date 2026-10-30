import * as Effect from "effect/Effect";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import type { SelectableProject } from "../../selectable-projects.js";
import type { ProjectCapabilityStub } from "../projects/index.js";

export type ObtainWorkspace = (
  project: SelectableProject,
  remainingMs: number,
  signal: AbortSignal,
) => Effect.Effect<ProjectCapabilityStub | null>;

type HeldWorkspace = Readonly<{
  capability: Promise<ProjectCapabilityStub | null>;
  release: AbortController;
}>;

/**
 * The capabilities a run's tools reach the workspace through, one per project, obtained on first
 * use. The Supervisor keeps the authority: ending them kills the commands still running through
 * them and refuses every later call from a duplicate the generation kept.
 */
export class HeldWorkspaces {
  readonly #obtain: ObtainWorkspace;
  readonly #held = new Map<string, HeldWorkspace>();

  constructor(obtain: ObtainWorkspace) {
    this.#obtain = obtain;
  }

  async capability(
    project: SelectableProject,
    remainingMs: number,
  ): Promise<ProjectRpcTargetContract> {
    const held = this.#held.get(project.id) ?? this.#hold(project, remainingMs);
    const capability = await held.capability;

    if (capability === null) throw new Error("the workspace is unavailable");

    return capability.dup();
  }

  endAll(): void {
    for (const held of this.#held.values()) {
      held.release.abort();
      void held.capability.then(end);
    }

    this.#held.clear();
  }

  #hold(project: SelectableProject, remainingMs: number): HeldWorkspace {
    const release = new AbortController();
    const capability = Effect.runPromise(this.#obtain(project, remainingMs, release.signal));
    const held = { capability, release };

    this.#held.set(project.id, held);
    void capability.then((obtained) => {
      if (obtained === null && this.#held.get(project.id) === held) this.#held.delete(project.id);
    });

    return held;
  }
}

function end(capability: ProjectCapabilityStub | null): void {
  if (capability === null) return;

  const dispose = () => {
    capability[Symbol.dispose]();
  };

  void capability.endTurn().then(dispose, dispose);
}
