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

  /** Start `operation` after every earlier operation for `projectId` has settled. */
  exclusive<T>(projectId: ProjectId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation);

    const settled = result.then(
      () => {},
      () => {},
    );

    this.tails.set(projectId, settled);
    void settled.then(() => {
      if (this.tails.get(projectId) === settled) this.tails.delete(projectId);
    });

    return result;
  }
}
