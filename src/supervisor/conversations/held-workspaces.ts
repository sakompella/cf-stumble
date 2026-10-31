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

export class HeldWorkspaces {
  readonly #obtain: ObtainWorkspace;
  readonly #held = new Map<string, HeldWorkspace>();

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
    held.release.abort();
    void held.capability.then(endTurn);
  }

  endAll(): void {
    for (const conversationId of this.#held.keys()) this.end(conversationId);
  }

  #hold(conversationId: string, project: SelectableProject, remainingMs: number): HeldWorkspace {
    const release = new AbortController();
    const capability = Effect.runPromise(this.#obtain(project, remainingMs, release.signal));
    const held = { capability, release };

    this.#held.set(conversationId, held);
    void capability.then((obtained) => {
      if (obtained === null && this.#held.get(conversationId) === held) {
        this.#held.delete(conversationId);
      }
    });

    return held;
  }
}

function endTurn(capability: ProjectCapabilityStub | null): void {
  if (capability === null) return;

  const dispose = () => {
    capability[Symbol.dispose]();
  };

  void capability.endTurn().then(dispose, dispose);
}
