// oxlint-disable anti-slop/no-unknown-parameters -- Every project id here arrives from a client through Durable Object RPC, so it is a string with no proven meaning until the catalog resolves it.
/// <reference types="@cloudflare/workers-types" />

import { parseAgentMessages } from "./messages.js";
import { ThreadStore, type ThreadLeaseResult } from "./store.js";
import {
  serializedThread,
  type ProjectThreadResult,
  type ProjectTurnLeaseResult,
  type ThreadResult,
} from "./thread.js";
import {
  resolveProject,
  EMPTY_PROJECT_CATALOG,
  type Project,
  type ProjectCatalog,
} from "../../project-catalog.js";

/**
 * Where the tenant's catalog comes from, read at each call rather than captured once.
 *
 * A Supervisor outlives the list of connected projects: the owner connects a repository while the
 * object is already running, and the thread surface has to resolve that project on the next
 * request. A catalog captured in the constructor would answer `unknown-project-id` for it until
 * the object was evicted.
 */
export type ProjectCatalogSource = () => ProjectCatalog;

type ResolvedProject =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{
      ok: false;
      problem: Readonly<{ code: "invalid-project-id" | "unknown-project-id" }>;
    }>;

/**
 * The thread surface a client reaches, and the only place a client-supplied project id turns into
 * a project.
 *
 * The catalog resolves the id first, and everything past that point works in `Project` values, so
 * the row a request touches is named by the server. A client can select one of the tenant's
 * projects; it cannot name a thread.
 */
export class ProjectThreads {
  private readonly store: ThreadStore;
  private readonly catalog: ProjectCatalogSource;

  constructor(storage: DurableObjectStorage, catalog: ProjectCatalogSource = emptyCatalog) {
    this.store = new ThreadStore(storage);
    this.catalog = catalog;
  }

  read(projectId: unknown): ProjectThreadResult {
    const resolved = this.resolve(projectId);
    return resolved.ok ? serialized(this.store.read(resolved.project)) : resolved;
  }

  startFreshThread(projectId: unknown): ProjectThreadResult {
    const resolved = this.resolve(projectId);
    return resolved.ok ? serialized(this.store.startFreshThread(resolved.project)) : resolved;
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
    const resolved = this.resolve(projectId);
    return resolved.ok
      ? serializedLease(this.store.startTurn(resolved.project, expectedRevision, now, leaseMs))
      : resolved;
  }

  finishTurn(
    projectId: unknown,
    leaseId: string,
    messages: unknown,
    now: number,
  ): ProjectThreadResult {
    const resolved = this.resolve(projectId);
    if (!resolved.ok) {
      return resolved;
    }

    const parsed = parseAgentMessages(messages);
    if (parsed.isErr()) {
      return {
        ok: false,
        problem: {
          code: "invalid-messages",
          projectId: resolved.project.id,
          reason: parsed.error.reason,
        },
      };
    }

    return serialized(this.store.finishTurn(resolved.project, parsed.value, now, leaseId));
  }

  abandonTurn(projectId: unknown, leaseId: string): ProjectThreadResult {
    const resolved = this.resolve(projectId);
    return resolved.ok ? serialized(this.store.abandonTurn(resolved.project, leaseId)) : resolved;
  }

  private resolve(projectId: unknown): ResolvedProject {
    const resolution = resolveProject(projectId, this.catalog());
    return resolution.ok
      ? { ok: true, project: resolution.project }
      : { ok: false, problem: { code: resolution.reason } };
  }
}

/** A Supervisor built without a catalog has no projects, so every id is unknown rather than a guess. */
function emptyCatalog(): ProjectCatalog {
  return EMPTY_PROJECT_CATALOG;
}

function serialized(result: ThreadResult): ProjectThreadResult {
  return result.ok ? { ok: true, thread: serializedThread(result.thread) } : result;
}

function serializedLease(result: ThreadLeaseResult): ProjectTurnLeaseResult {
  return result.ok
    ? { ok: true, thread: serializedThread(result.lease.thread), leaseId: result.lease.leaseId }
    : result;
}
