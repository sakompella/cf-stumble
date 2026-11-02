import {
  canonicalRepositoryUrl,
  defaultProjectDisplayName,
  projectIdForRepository,
  type Project,
  type ProjectCatalog,
  type ProjectId,
  type PublicRepositoryUrl,
} from "../../project-catalog.js";

const PROJECT_COLUMNS =
  "project_id AS id, display_name AS displayName, repository_url AS repositoryUrl";

type ConnectProjectProblem = Readonly<{ code: "invalid-repository-url" }>;

type ConnectProjectResult =
  | Readonly<{ ok: true; project: Project; alreadyConnected: boolean }>
  | Readonly<{ ok: false; problem: ConnectProjectProblem }>;

interface ConnectProjectInput {
  readonly repositoryUrl: string;
  readonly displayName?: string | undefined;
}

const DISPLAY_NAME_LIMIT = 80;

function chosenDisplayName(value: string | undefined, repositoryUrl: PublicRepositoryUrl): string {
  const trimmed = (value ?? "").trim();

  return trimmed.length === 0
    ? defaultProjectDisplayName(repositoryUrl)
    : trimmed.slice(0, DISPLAY_NAME_LIMIT);
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

  catalog(): ProjectCatalog {
    return Object.freeze(
      this.sql
        .exec<Project>(
          `SELECT ${PROJECT_COLUMNS}
           FROM connected_projects ORDER BY connected_at ASC, project_id ASC`,
        )
        .toArray(),
    );
  }

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
        return { ok: true, project: existing, alreadyConnected: true };
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

  private byId(id: ProjectId): Project | undefined {
    return this.sql
      .exec<Project>(`SELECT ${PROJECT_COLUMNS} FROM connected_projects WHERE project_id = ?`, id)
      .toArray()[0];
  }
}
