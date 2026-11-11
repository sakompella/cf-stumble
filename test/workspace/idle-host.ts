import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Workspace, type SyncProgress } from "@cloudflare/computer";
import { vi } from "vitest";
import { WorkspaceHost } from "../../src/workspace/host.js";

export class FakeContainer {
  running = true;
  readonly images = { app: "workspace-image" };
  readonly destroyed: unknown[] = [];
  readonly pulledBefore: unknown[][] = [];
  readonly inactivityTimeoutsMs: number[] = [];
  starts = 0;
  destroyGate: Promise<void> | undefined;

  start(): void {
    this.starts += 1;

    throw new Error("the fake container does not launch");
  }

  setInactivityTimeout(durationMs: number): Promise<void> {
    this.inactivityTimeoutsMs.push(durationMs);

    return Promise.resolve();
  }

  destroy(reason?: string): Promise<void> {
    this.destroyed.push(reason);
    const gate = this.destroyGate ?? Promise.resolve();
    this.destroyGate = undefined;

    if (reason === undefined) return gate;

    return gate.then(() => {
      this.running = false;
    });
  }
}

const CURSOR = { rev: 0, path: null };

const PULLED: SyncProgress = {
  operationId: "fake",
  generation: "fake",
  backend: "container-shell",
  direction: "pull",
  mode: "entries",
  cursor: CURSOR,
  targetCursor: CURSOR,
  entries: 0,
  bytes: 0,
  skipped: 0,
  complete: true,
};

async function* pulled(container: FakeContainer): AsyncIterable<SyncProgress> {
  container.pulledBefore.push([...container.destroyed]);
  yield await Promise.resolve(PULLED);
}

export function withHost<T>(
  name: string,
  run: (host: WorkspaceHost, state: DurableObjectState, container: FakeContainer) => Promise<T>,
): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    const container = new FakeContainer();

    Object.defineProperty(state, "container", { value: container, configurable: true });
    vi.spyOn(Workspace.prototype, "pull").mockImplementation(() => pulled(container));

    return run(
      new WorkspaceHost(state, { LOADER: env.LOADER, ASSETS: env.ASSETS }),
      state,
      container,
    );
  });
}
