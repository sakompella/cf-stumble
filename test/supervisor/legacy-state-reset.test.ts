/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectedProjects, GitHubConnectionStore } from "../../src/supervisor/projects/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { capturedEvents, named } from "../log-capture.js";
import { activateFixtureGeneration, connectSampleProjects, submitCandidate } from "./helpers.js";
import { FakeTenantWorkspace } from "./projects/fake-tenant-workspace.js";
import { tenantConnections } from "./projects/tenant-connections.js";

/**
 * The one-time reset of Supervisor state from before 8d0469f (`legacy-state-reset.ts`).
 *
 * A legacy Supervisor is made the only way this runtime allows: construct one, rewrite its SQLite
 * into the old form and remove the marker, then evict it so the next request constructs it again
 * over that storage, as the first request after a deploy does.
 */

const LEGACY_URL = "https://github.com/sample/my.repo";

/** What the id rule before 8d0469f derived for `sample/my.repo`. */
const LEGACY_ID = "sample-my-repo";

const CURRENT_ID = "sample-my-repo--2d";

const LEGACY_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const RESET_EVENT = "supervisor.legacy-state-reset";

const connection = {
  login: "legacy-owner",
  source: "device-authorization",
  connectedAt: 1,
} as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function legacySupervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  // An active generation, so generation_state and active_generation_history reference it.
  await activateFixtureGeneration(control);

  await runInDurableObject(control, (_instance, state) => {
    const { sql } = state.storage;
    sql.exec(
      `INSERT INTO connected_projects (project_id, display_name, repository_url, connected_at)
       VALUES (?, 'my.repo', ?, 0)`,
      LEGACY_ID,
      LEGACY_URL,
    );
    sql.exec("DROP TABLE project_threads");
    sql.exec(`
      CREATE TABLE project_threads (
        project_id TEXT PRIMARY KEY,
        messages TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        turn_active INTEGER NOT NULL DEFAULT 0,
        turn_deadline_at INTEGER,
        turn_lease_id TEXT
      );
      INSERT INTO project_threads (project_id, messages) VALUES ('sample-my-repo', '[]');
    `);
    // No current store creates this table, and its name sorts after the generations it
    // references, so it stands for a table an older version left behind.
    sql.exec(`
      CREATE TABLE retired_generation_notes (label INTEGER NOT NULL REFERENCES generations(label));
      INSERT INTO retired_generation_notes (label) VALUES (0);
    `);
    new GitHubConnectionStore(state.storage).recordConnection(connection);
    sql.exec("DROP TABLE IF EXISTS legacy_state_reset");

    expect(
      () => new ConnectedProjects(state.storage).connect({ repositoryUrl: LEGACY_URL }, 1),
      "the fixture must hold the legacy row that fails a reconnect",
    ).toThrow(/UNIQUE/u);
  });

  await evictDurableObject(control);

  return control;
}

function connectedRows(control: DurableObjectStub<Supervisor>) {
  return runInDurableObject(control, (_instance, state) =>
    state.storage.sql
      .exec<{ readonly project_id: string }>("SELECT project_id FROM connected_projects")
      .toArray()
      .map((row) => row.project_id),
  );
}

test("drops legacy Supervisor state once and keeps the GitHub connection", async () => {
  const control = await legacySupervisor("legacy-state-reset");
  const events = capturedEvents();

  await expect(control.getGenerations()).resolves.toEqual([]);

  const after = await runInDurableObject(control, (_instance, state) => ({
    projects: state.storage.sql.exec("SELECT project_id FROM connected_projects").toArray(),
    threadColumns: state.storage.sql
      .exec<{ readonly name: string }>("PRAGMA table_info(project_threads)")
      .toArray()
      .map((column) => column.name),
    threads: state.storage.sql.exec("SELECT project_id FROM project_threads").toArray(),
    retired: state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name = 'retired_generation_notes'")
      .toArray(),
    github: new GitHubConnectionStore(state.storage).connection(),
  }));

  expect(after.projects).toEqual([]);
  expect(after.threads).toEqual([]);
  expect(after.retired).toEqual([]);
  expect(after.threadColumns).toContain("turn_holder_id");
  expect(after.github).toEqual(connection);

  const [event, ...more] = named(events(), RESET_EVENT);
  expect(more).toEqual([]);
  expect(event).toMatchObject({
    level: "info",
    "rows.connected_projects": 1,
    "rows.project_threads": 1,
    "rows.generations": 1,
    "rows.generation_state": 1,
    "rows.active_generation_history": 1,
    "rows.retired_generation_notes": 1,
  });
  expect(event).not.toHaveProperty("rows.github_connection");
  expect(JSON.stringify(event)).not.toMatch(/my\.repo|legacy-owner/u);

  const workspace = new FakeTenantWorkspace();

  const connected = await runInDurableObject(control, (_instance, state) =>
    tenantConnections(state.storage, "legacy-state-reset", workspace, {
      clientId: undefined,
      fallbackToken: undefined,
      fetcher: () => Promise.resolve(Response.json({ message: "rate limit exceeded" })),
    }).connections.connect(LEGACY_URL, undefined, 2),
  );

  expect(connected).toMatchObject({
    ok: true,
    project: { id: CURRENT_ID, repositoryUrl: LEGACY_URL },
    alreadyConnected: false,
  });
});

test("keeps state written after the reset across a restart", async () => {
  const control = await legacySupervisor("legacy-state-reset-restart");
  await expect(control.getGenerations()).resolves.toEqual([]);
  await connectSampleProjects(control);
  await submitCandidate(control, LEGACY_COMMIT);
  const projectsBefore = await connectedRows(control);
  const generationsBefore = await control.getGenerations();

  await evictDurableObject(control);
  const events = capturedEvents();

  await expect(control.getGenerations()).resolves.toEqual(generationsBefore);
  await expect(connectedRows(control)).resolves.toEqual(projectsBefore);
  expect(projectsBefore).toHaveLength(2);
  expect(named(events(), RESET_EVENT)).toEqual([]);
});

test("gives an empty Supervisor the marker and logs nothing", async () => {
  const events = capturedEvents();
  const control = env.SUPERVISOR.getByName("legacy-state-reset-empty");

  await expect(control.getGenerations()).resolves.toEqual([]);

  const markers = await runInDurableObject(control, (_instance, state) =>
    state.storage.sql.exec("SELECT id FROM legacy_state_reset").toArray(),
  );

  expect(markers).toEqual([{ id: 1 }]);
  expect(named(events(), RESET_EVENT)).toEqual([]);
});
