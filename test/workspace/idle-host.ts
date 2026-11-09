import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { WorkspaceHost } from "../../src/workspace/host.js";

export class FakeContainer {
  running = true;
  readonly images = { app: "workspace-image" };
  readonly destroyed: unknown[] = [];
  starts = 0;
  destroyGate: Promise<void> | undefined;

  start(): void {
    this.starts += 1;

    throw new Error("the fake container does not launch");
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

export function withHost<T>(
  name: string,
  run: (host: WorkspaceHost, state: DurableObjectState, container: FakeContainer) => Promise<T>,
): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    const container = new FakeContainer();

    Object.defineProperty(state, "container", { value: container, configurable: true });

    return run(
      new WorkspaceHost(state, { LOADER: env.LOADER, ASSETS: env.ASSETS }),
      state,
      container,
    );
  });
}
