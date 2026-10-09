// oxlint-disable anti-slop/no-unknown-parameters -- Every project id here arrives from a client through Durable Object RPC, so it is a string with no proven meaning until the catalog resolves it.

import { Result } from "better-result";
import { parseAgentMessages } from "./messages.js";
import { ThreadStore, type ThreadLease } from "./store.js";
import {
  serializedThread,
  type ProjectThread,
  type ProjectThreadProblem,
  type ProjectThreadResult,
  type ProjectTurnLeaseResult,
} from "./thread.js";
import {
  resolveSelectableProject,
  type SelectableCatalog,
  type SelectableProject,
} from "../../selectable-projects.js";

/**
 * Where the tenant's catalog comes from, read at each call rather than captured once.
 *
 * A Supervisor outlives the list of connected projects: the owner connects a repository while the
 * object is already running, and the thread surface has to resolve that project on the next
 * request. A catalog captured in the constructor would answer `unknown-project-id` for it until
 * the object was evicted.
 */
type ProjectCatalogSource = () => SelectableCatalog;

type CatalogProblem = Readonly<{ code: "invalid-project-id" | "unknown-project-id" }>;

export type DisconnectProjectResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      problem: Readonly<{
        code: "invalid-project-id" | "unknown-project-id" | "harness-project" | "turn-active";
        deadlineAt?: number;
      }>;
    }>;

/**
 * The thread surface a client reaches, and the only place a client-supplied project id turns into
 * a selectable project.
 *
 * The catalog resolves the id first, and everything past that point works in `SelectableProject`
 * values, so the row a request touches is named by the server. A client can select one of the
 * tenant's repositories or the harness entry; it cannot name a thread. The harness gets its own
 * row for the same reason every repository does: one current conversation per thing you can be
 * working in, and a fresh thread on one leaves the others alone.
 */
export class ProjectThreads {
  private readonly store: ThreadStore;
  private readonly catalog: ProjectCatalogSource;

  constructor(storage: DurableObjectStorage, catalog: ProjectCatalogSource, holderId?: string) {
    this.store = new ThreadStore(storage, holderId);
    this.catalog = catalog;
  }

  read(projectId: unknown): ProjectThreadResult {
    return plainThread(this.resolve(projectId).andThen((project) => this.store.read(project)));
  }

  startFreshThread(projectId: unknown): ProjectThreadResult {
    return plainThread(
      this.resolve(projectId).map((project) => this.store.startFreshThread(project)),
    );
  }

  /**
   * Admit one turn on the project's thread. The caller presents the revision it read; the store
   * mints the lease id and this is where it reaches the caller.
   */
  startTurn(
    projectId: unknown,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): ProjectTurnLeaseResult {
    return plainLease(
      this.resolve(projectId).andThen((project) =>
        this.store.startTurn(project, expectedRevision, now, leaseMs),
      ),
    );
  }

  finishTurn(
    projectId: unknown,
    leaseId: string,
    messages: unknown,
    now: number,
  ): ProjectThreadResult {
    return plainThread(
      this.resolve(projectId).andThen((project) =>
        parseAgentMessages(messages)
          .mapError((unreadable): ProjectThreadProblem => ({
            code: "invalid-messages",
            projectId: project.id,
            reason: unreadable.reason,
          }))
          .andThen((parsed) => this.store.finishTurn(project, parsed, now, leaseId)),
      ),
    );
  }

  abandonTurn(projectId: unknown, leaseId: string): ProjectThreadResult {
    return plainThread(
      this.resolve(projectId).andThen((project) => this.store.abandonTurn(project, leaseId)),
    );
  }

  disconnectProject(projectId: unknown, now: number): DisconnectProjectResult {
    const resolved = this.resolve(projectId);

    if (resolved.isErr()) return { ok: false, problem: resolved.error };

    if (resolved.value.kind === "harness") {
      return { ok: false, problem: { code: "harness-project" } };
    }

    return this.store.remove(resolved.value, now).match<DisconnectProjectResult>({
      ok: () => ({ ok: true }),
      err: (problem) =>
        problem.code === "turn-active"
          ? { ok: false, problem }
          : { ok: false, problem: { code: "unknown-project-id" } },
    });
  }

  private resolve(projectId: unknown): Result<SelectableProject, CatalogProblem> {
    const resolution = resolveSelectableProject(projectId, this.catalog());

    return resolution.ok ? Result.ok(resolution.project) : Result.err({ code: resolution.reason });
  }
}

// The thread surface composes Results and converts once, here, because these plain unions are what
// getProjectThread and startFreshProjectThread return over Supervisor RPC (ADR-0035).
function plainThread(result: Result<ProjectThread, ProjectThreadProblem>): ProjectThreadResult {
  return result.match<ProjectThreadResult>({
    ok: (thread) => ({ ok: true, thread: serializedThread(thread) }),
    err: (problem) => ({ ok: false, problem }),
  });
}

function plainLease(result: Result<ThreadLease, ProjectThreadProblem>): ProjectTurnLeaseResult {
  return result.match<ProjectTurnLeaseResult>({
    ok: ({ thread, leaseId, reclaimed }) =>
      reclaimed
        ? { ok: true, thread: serializedThread(thread), leaseId, reclaimed: true }
        : { ok: true, thread: serializedThread(thread), leaseId },
    err: (problem) => ({ ok: false, problem }),
  });
}
