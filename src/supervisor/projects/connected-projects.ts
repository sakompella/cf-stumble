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
import { HARNESS_PROJECT_ID } from "../../selectable-projects.js";

type ConnectedProject = Readonly<{
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

/** A conflict means the URL derives the harness entry's id. */
type ConnectProjectProblem = Readonly<{
  code: "invalid-repository-url" | "project-id-conflict";
}>;

type ConnectProjectResult =
  | Readonly<{ ok: true; project: Project; alreadyConnected: boolean }>
  | Readonly<{ ok: false; problem: ConnectProjectProblem }>;

interface ConnectProjectInput {
  readonly repositoryUrl: unknown;
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

  list(): readonly ConnectedProject[] {
    return this.sql
      .exec<ConnectedProjectRow>(
        `SELECT project_id, display_name, repository_url, connected_at
         FROM connected_projects ORDER BY connected_at ASC, project_id ASC`,
      )
      .toArray()
      .map((row) => projectFromRow(row));
  }

  catalog(): ProjectCatalog {
    return Object.freeze(
      this.list().map(({ id, displayName, repositoryUrl }) => ({
        id,
        displayName,
        repositoryUrl,
      })),
    );
  }

  connect(input: ConnectProjectInput, now: number): ConnectProjectResult {
    const repositoryUrl = canonicalRepositoryUrl(input.repositoryUrl);
    const id = repositoryUrl === undefined ? undefined : projectIdForRepository(repositoryUrl);

    if (repositoryUrl === undefined || id === undefined) {
      return { ok: false, problem: { code: "invalid-repository-url" } };
    }

    if (id === HARNESS_PROJECT_ID) {
      // The harness entry owns that id, so a row holding it could never be selected.
      return { ok: false, problem: { code: "project-id-conflict" } };
    }

    const displayName = chosenDisplayName(input.displayName, repositoryUrl);

    return this.storage.transactionSync(() => {
      const existing = this.byId(id);

      if (existing !== undefined) {
        return {
          ok: true,
          project: {
            id: existing.id,
            displayName: existing.displayName,
            repositoryUrl: existing.repositoryUrl,
          },
          alreadyConnected: true,
        };
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
