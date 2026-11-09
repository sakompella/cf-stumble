import * as Schema from "effect/Schema";
import {
  canonicalRepositoryUrl,
  defaultProjectDisplayName,
  projectIdForRepository,
  type Project,
  type ProjectCatalog,
  type ProjectId,
  type PublicRepositoryUrl,
} from "../../project-catalog.js";
import {
  lifecycleStep,
  LifecycleEvent,
  ProjectState,
  type LifecycleCommand,
} from "./project-lifecycle-machine.js";

const PROJECT_COLUMNS =
  "project_id AS id, display_name AS displayName, repository_url AS repositoryUrl";

type ProjectRow = Project & { readonly state: string };

type ConnectProjectProblem = Readonly<{ code: "invalid-repository-url" }>;

export type ProjectTransition = Readonly<{
  project: Project;
  before: ProjectState | undefined;
  after: ProjectState | undefined;
  commands: readonly LifecycleCommand[];
}>;

export type ConnectProjectResult =
  | (Readonly<{ ok: true }> & ProjectTransition)
  | Readonly<{ ok: false; problem: ConnectProjectProblem }>;

interface ConnectProjectInput {
  readonly repositoryUrl: string;
  readonly displayName?: string | undefined;
}

const DISPLAY_NAME_LIMIT = 80;

const decodeState = Schema.decodeUnknownSync(ProjectState);

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
    storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS connected_projects (
          project_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          repository_url TEXT NOT NULL UNIQUE,
          connected_at INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'connected'
            CHECK (state IN ('provisioning', 'connected', 'removing'))
        );
      `);

      const columns = this.sql
        .exec<{ readonly name: string }>(`SELECT name FROM pragma_table_info('connected_projects')`)
        .toArray();

      if (!columns.some(({ name }) => name === "state")) {
        this.sql.exec(`
          ALTER TABLE connected_projects ADD COLUMN state TEXT NOT NULL DEFAULT 'connected'
            CHECK (state IN ('provisioning', 'connected', 'removing'))
        `);
      }
    });
  }

  catalog(): ProjectCatalog {
    return this.listed(["connected"]);
  }

  provisionable(): ProjectCatalog {
    return this.listed(["connected", "provisioning"]);
  }

  unfinished(): readonly Readonly<{ id: ProjectId; state: ProjectState }>[] {
    return this.sql
      .exec<{ readonly id: ProjectId; readonly state: string }>(
        `SELECT project_id AS id, state FROM connected_projects
         WHERE state <> 'connected' ORDER BY connected_at ASC, project_id ASC`,
      )
      .toArray()
      .map(({ id, state }) => ({ id, state: decodeState(state) }));
  }

  stateOf(id: ProjectId): ProjectState | undefined {
    const row = this.row(id);

    return row === undefined ? undefined : decodeState(row.state);
  }

  connect(input: ConnectProjectInput, now: number): ConnectProjectResult {
    const repositoryUrl = canonicalRepositoryUrl(input.repositoryUrl);
    const id = repositoryUrl === undefined ? undefined : projectIdForRepository(repositoryUrl);

    if (repositoryUrl === undefined || id === undefined) {
      return { ok: false, problem: { code: "invalid-repository-url" } };
    }

    const created = {
      id,
      displayName: chosenDisplayName(input.displayName, repositoryUrl),
      repositoryUrl,
    };

    return this.storage.transactionSync(() => {
      const row = this.row(id);
      const project = row ?? created;
      const before = row === undefined ? undefined : decodeState(row.state);

      return {
        ok: true,
        ...this.commit(project, before, LifecycleEvent.cases.connect.make({}), now),
      };
    });
  }

  apply(id: ProjectId, event: LifecycleEvent): ProjectTransition | undefined {
    return this.storage.transactionSync(() => {
      const row = this.row(id);

      return row === undefined ? undefined : this.commit(row, decodeState(row.state), event, 0);
    });
  }

  private commit(
    project: Project,
    before: ProjectState | undefined,
    event: LifecycleEvent,
    now: number,
  ): ProjectTransition {
    const { state: after, commands } = lifecycleStep(before, event);

    this.write(project, before, after, now);

    return {
      project: {
        id: project.id,
        displayName: project.displayName,
        repositoryUrl: project.repositoryUrl,
      },
      before,
      after,
      commands,
    };
  }

  private write(
    project: Project,
    before: ProjectState | undefined,
    after: ProjectState | undefined,
    now: number,
  ): void {
    if (after === before) return;

    if (after === undefined) {
      this.sql.exec(`DELETE FROM connected_projects WHERE project_id = ?`, project.id);
    } else if (before === undefined) {
      this.sql.exec(
        `INSERT INTO connected_projects
           (project_id, display_name, repository_url, connected_at, state)
         VALUES (?, ?, ?, ?, ?)`,
        project.id,
        project.displayName,
        project.repositoryUrl,
        now,
        after,
      );
    } else {
      this.sql.exec(
        `UPDATE connected_projects SET state = ? WHERE project_id = ?`,
        after,
        project.id,
      );
    }
  }

  private listed(states: readonly ProjectState[]): ProjectCatalog {
    return Object.freeze(
      this.sql
        .exec<Project>(
          `SELECT ${PROJECT_COLUMNS} FROM connected_projects
           WHERE state IN (${states.map(() => "?").join(", ")})
           ORDER BY connected_at ASC, project_id ASC`,
          ...states,
        )
        .toArray(),
    );
  }

  private row(id: ProjectId): ProjectRow | undefined {
    return this.sql
      .exec<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS}, state FROM connected_projects WHERE project_id = ?`,
        id,
      )
      .toArray()[0];
  }
}
