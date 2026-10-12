// oxlint-disable anti-slop/no-unknown-parameters -- Every project id here arrives from a client through Durable Object RPC, so it is a string with no proven meaning until the catalog resolves it.

import * as Result from "effect/Result";
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
    return plainThread(
      this.resolve(projectId).pipe(Result.flatMap((project) => this.store.read(project))),
    );
  }

  startFreshThread(projectId: unknown): ProjectThreadResult {
    return plainThread(
      this.resolve(projectId).pipe(Result.map((project) => this.store.startFreshThread(project))),
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
      this.resolve(projectId).pipe(
        Result.flatMap((project) => this.store.startTurn(project, expectedRevision, now, leaseMs)),
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
      this.resolve(projectId).pipe(
        Result.flatMap((project) =>
          parseAgentMessages(messages).pipe(
            Result.mapError((unreadable): ProjectThreadProblem => ({
              code: "invalid-messages",
              projectId: project.id,
              reason: unreadable.reason,
            })),
            Result.flatMap((parsed) => this.store.finishTurn(project, parsed, now, leaseId)),
          ),
        ),
      ),
    );
  }

  abandonTurn(projectId: unknown, leaseId: string): ProjectThreadResult {
    return plainThread(
      this.resolve(projectId).pipe(
        Result.flatMap((project) => this.store.abandonTurn(project, leaseId)),
      ),
    );
  }

  disconnectProject(projectId: unknown, now: number): DisconnectProjectResult {
    const resolved = this.resolve(projectId);

    if (Result.isFailure(resolved)) return { ok: false, problem: resolved.failure };

    if (resolved.success.kind === "harness") {
      return { ok: false, problem: { code: "harness-project" } };
    }

    return Result.match(this.store.remove(resolved.success, now), {
      onSuccess: (): DisconnectProjectResult => ({ ok: true }),
      onFailure: (problem): DisconnectProjectResult =>
        problem.code === "turn-active"
          ? { ok: false, problem }
          : { ok: false, problem: { code: "unknown-project-id" } },
    });
  }

  private resolve(projectId: unknown): Result.Result<SelectableProject, CatalogProblem> {
    const resolution = resolveSelectableProject(projectId, this.catalog());

    return resolution.ok
      ? Result.succeed(resolution.project)
      : Result.fail({ code: resolution.reason });
  }
}

// The thread surface composes Results and converts once, here, because these plain unions are what
// getProjectThread and startFreshProjectThread return over Supervisor RPC (ADR-0045).
function plainThread(
  result: Result.Result<ProjectThread, ProjectThreadProblem>,
): ProjectThreadResult {
  return Result.match(result, {
    onSuccess: (thread): ProjectThreadResult => ({ ok: true, thread: serializedThread(thread) }),
    onFailure: (problem): ProjectThreadResult => ({ ok: false, problem }),
  });
}

function plainLease(
  result: Result.Result<ThreadLease, ProjectThreadProblem>,
): ProjectTurnLeaseResult {
  return Result.match(result, {
    onSuccess: ({ thread, leaseId, reclaimed }): ProjectTurnLeaseResult =>
      reclaimed
        ? { ok: true, thread: serializedThread(thread), leaseId, reclaimed: true }
        : { ok: true, thread: serializedThread(thread), leaseId },
    onFailure: (problem): ProjectTurnLeaseResult => ({ ok: false, problem }),
  });
}
