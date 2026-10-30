// oxlint-disable anti-slop/no-unknown-parameters -- Every project id here arrives from a client through Durable Object RPC, so it is a string with no proven meaning until the catalog resolves it.

import * as Result from "effect/Result";
import type { LiveTurn } from "./live-turn.js";
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

/** Read at each call: a repository connected while the object runs must resolve on the next request. */
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

/** The only place a client-supplied project id becomes a selectable project, so the server names the row a request touches. */
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

  startFreshThread(projectId: unknown, now: number): ProjectThreadResult {
    return plainThread(
      this.resolve(projectId).pipe(
        Result.flatMap((project) => this.store.startFreshThread(project, now)),
      ),
    );
  }

  liveTurn(now: number): LiveTurn | undefined {
    return this.store.liveTurn(now);
  }

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

// Composes Results and converts once: these plain unions cross Supervisor RPC.
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
