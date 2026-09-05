/// <reference types="@cloudflare/workers-types" />

import {
  canonicalRepositoryUrl,
  defaultProjectDisplayName,
  parseProjectCatalog,
  projectIdForRepository,
  type Project,
  type ProjectCatalog,
  type ProjectId,
  type PublicRepositoryUrl,
} from "../../project-catalog.js";

/**
 * The repositories this tenant has connected, and the only place that list is decided.
 *
 * It is a table rather than a constant because connecting a repository is something the owner does
 * at runtime: the catalog starts empty, grows by one row per connection, and every consumer
 * resolves ids against whatever it holds now. Identity comes from the repository URL
 * (`projectIdForRepository`), so connecting the same repository twice converges on the row that is
 * already there instead of adding a second project for the same clone, and renaming a project or
 * connecting a third one moves nothing.
 *
 * Nothing here is credential-bearing. A row is an id, a name a person chose, a public repository
 * URL, and when it was connected.
 */
export type ConnectedProject = Readonly<{
  id: ProjectId;
  displayName: string;
  repositoryUrl: PublicRepositoryUrl;
  connectedAt: number;
}>;

type ConnectedProjectRow = {
  readonly project_id: string;
  readonly display_name: string;
  readonly repository_url: string;
  readonly connected_at: number;
};

/**
 * Why a repository did not become a project. A conflict is the honest answer when two different
 * repositories reduce to one id: cf-stumble will not quietly point an existing project at a
 * different clone.
 */
export type ConnectProjectProblem = Readonly<{
  code: "invalid-repository-url" | "project-id-conflict";
}>;

export type ConnectProjectResult =
  | Readonly<{ ok: true; project: Project; alreadyConnected: boolean }>
  | Readonly<{ ok: false; problem: ConnectProjectProblem }>;

/** What a caller asks for. Both fields are client text; neither becomes a path or a command. */
export interface ConnectProjectInput {
  // oxlint-disable-next-line anti-slop/no-unknown-type-aliases -- Boundary: this is a client-supplied repository URL with no proven shape.
  readonly repositoryUrl: unknown;
  // oxlint-disable-next-line anti-slop/no-unknown-type-aliases -- Boundary: this is a client-supplied display name with no proven shape.
  readonly displayName?: unknown;
}

const DISPLAY_NAME_LIMIT = 80;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the display name arrives from a client.
function chosenDisplayName(value: unknown, repositoryUrl: PublicRepositoryUrl): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the display name is untrusted.
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length === 0
    ? defaultProjectDisplayName(repositoryUrl)
    : trimmed.slice(0, DISPLAY_NAME_LIMIT);
}

function projectFromRow(row: ConnectedProjectRow): ConnectedProject {
  const catalog = parseProjectCatalog([
    {
      id: row.project_id,
      displayName: row.display_name,
      repositoryUrl: row.repository_url,
    },
  ]);
  const project = catalog?.[0];
  if (project === undefined) {
    throw new Error(`invalid connected project row ${row.project_id}`);
  }

  return { ...project, connectedAt: row.connected_at };
}

export class ConnectedProjects {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS connected_projects (
        project_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        repository_url TEXT NOT NULL UNIQUE,
        connected_at INTEGER NOT NULL
      );
    `);
  }

  /** Every connected project, oldest first. The order is presentation; nothing resolves by it. */
  list(): readonly ConnectedProject[] {
    return this.sql
      .exec<ConnectedProjectRow>(
        `SELECT project_id, display_name, repository_url, connected_at
         FROM connected_projects ORDER BY connected_at ASC, project_id ASC`,
      )
      .toArray()
      .map((row) => projectFromRow(row));
  }

  /** The tenant's catalog, as every consumer of `resolveProject` needs it. */
  catalog(): ProjectCatalog {
    return Object.freeze(
      this.list().map(({ id, displayName, repositoryUrl }) => ({
        id,
        displayName,
        repositoryUrl,
      })),
    );
  }

  /**
   * Connect one repository, or converge on the project that already holds it.
   *
   * A repeat of the same URL returns the existing project with `alreadyConnected`, so a caller
   * that retries after a lost response gets the same project rather than a second one. A URL that
   * reduces to an id another repository already owns is refused, because the alternative is
   * repointing a project's clone from underneath its thread and its files.
   */
  connect(input: ConnectProjectInput, now: number): ConnectProjectResult {
    const repositoryUrl = canonicalRepositoryUrl(input.repositoryUrl);
    const id = repositoryUrl === undefined ? undefined : projectIdForRepository(repositoryUrl);
    if (repositoryUrl === undefined || id === undefined) {
      return { ok: false, problem: { code: "invalid-repository-url" } };
    }

    const displayName = chosenDisplayName(input.displayName, repositoryUrl);
    return this.storage.transactionSync(() => {
      const existing = this.byId(id);
      if (existing !== undefined) {
        return existing.repositoryUrl === repositoryUrl
          ? {
              ok: true,
              project: {
                id: existing.id,
                displayName: existing.displayName,
                repositoryUrl: existing.repositoryUrl,
              },
              alreadyConnected: true,
            }
          : { ok: false, problem: { code: "project-id-conflict" } };
      }

      this.sql.exec(
        `INSERT INTO connected_projects (project_id, display_name, repository_url, connected_at)
         VALUES (?, ?, ?, ?)`,
        id,
        displayName,
        repositoryUrl,
        now,
      );
      return { ok: true, project: { id, displayName, repositoryUrl }, alreadyConnected: false };
    });
  }

  /**
   * Remove one project's row. This is the undo half of a connection whose clone never landed: the
   * catalog is what the page lists and what `resolveProject` answers from, so a project that has
   * no repository in the workspace must not stay in it.
   */
  disconnect(id: ProjectId): void {
    this.sql.exec(`DELETE FROM connected_projects WHERE project_id = ?`, id);
  }

  private byId(id: ProjectId): ConnectedProject | undefined {
    const row = this.sql
      .exec<ConnectedProjectRow>(
        `SELECT project_id, display_name, repository_url, connected_at
         FROM connected_projects WHERE project_id = ?`,
        id,
      )
      .toArray()[0];
    return row === undefined ? undefined : projectFromRow(row);
  }
}
