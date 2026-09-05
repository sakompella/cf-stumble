/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { ConnectedProjects } from "../../../src/supervisor/projects/index.js";
import { projectIdForRepository, resolveProject } from "../../../src/project-catalog.js";

/**
 * The tenant's connected repositories, in the Supervisor's own storage.
 *
 * The catalog used to be two entries in the source, so a tenant had exactly two projects and no
 * connect flow could add a third. These tests hold the properties that replaced that: any number
 * of projects, identity that comes from the repository rather than from a position or a name, and
 * a repeat connection that converges instead of duplicating.
 */

const NOW = 1_700_000_000_000;

function withProjects<T>(name: string, use: (projects: ConnectedProjects) => T): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
    use(new ConnectedProjects(state.storage)),
  );
}

afterEach(async () => {
  await reset();
});

test("a tenant that has connected nothing has an empty catalog", async () => {
  await withProjects("catalog-empty", (projects) => {
    expect(projects.catalog()).toEqual([]);
    expect(projects.list()).toEqual([]);
    expect(resolveProject("sample-project-one", projects.catalog())).toEqual({
      ok: false,
      reason: "unknown-project-id",
    });
  });
});

test.each([1, 2, 3])("holds %i connected repositories and resolves every one", async (count) => {
  await withProjects(`catalog-of-${count}`, (projects) => {
    for (let index = 0; index < count; index += 1) {
      const connected = projects.connect(
        { repositoryUrl: `https://github.com/sample/repo-${index}` },
        NOW + index,
      );
      expect(connected).toMatchObject({ ok: true, alreadyConnected: false });
    }

    const catalog = projects.catalog();
    expect(catalog).toHaveLength(count);
    for (const project of catalog) {
      expect(resolveProject(project.id, catalog)).toEqual({ ok: true, project });
    }
  });
});

test("connecting the same repository again converges on the project already there", async () => {
  await withProjects("catalog-converges", (projects) => {
    const first = projects.connect(
      { repositoryUrl: "https://github.com/Sample/Repo-1", displayName: "first name" },
      NOW,
    );
    const again = projects.connect(
      { repositoryUrl: "https://github.com/Sample/Repo-1.git/", displayName: "second name" },
      NOW + 1_000,
    );

    expect(first).toMatchObject({ ok: true, alreadyConnected: false });
    expect(again).toEqual({
      ok: true,
      alreadyConnected: true,
      project: {
        id: projectIdForRepository("https://github.com/Sample/Repo-1"),
        displayName: "first name",
        repositoryUrl: "https://github.com/Sample/Repo-1",
      },
    });
    expect(projects.list()).toHaveLength(1);
  });
});

test("identity survives the order of connection and the name a project is shown under", async () => {
  const forward = await withProjects("catalog-order-forward", (projects) => {
    projects.connect({ repositoryUrl: "https://github.com/sample/alpha" }, NOW);
    projects.connect(
      { repositoryUrl: "https://github.com/sample/beta", displayName: "B" },
      NOW + 1,
    );
    return projects.catalog().map((project) => project.id);
  });
  const reversed = await withProjects("catalog-order-reversed", (projects) => {
    projects.connect({ repositoryUrl: "https://github.com/sample/beta" }, NOW);
    projects.connect(
      { repositoryUrl: "https://github.com/sample/alpha", displayName: "A" },
      NOW + 1,
    );
    return projects
      .catalog()
      .map((project) => project.id)
      .toSorted();
  });

  expect(forward).toEqual(["sample-alpha", "sample-beta"]);
  expect(reversed).toEqual(forward);
});

test("refuses to repoint an existing project at a different repository", async () => {
  await withProjects("catalog-conflict", (projects) => {
    projects.connect({ repositoryUrl: "https://github.com/sample/my-repo" }, NOW);

    const conflicting = projects.connect(
      { repositoryUrl: "https://github.com/sample/my.repo" },
      NOW + 1,
    );

    expect(conflicting).toEqual({ ok: false, problem: { code: "project-id-conflict" } });
    expect(projects.list().map((project) => project.repositoryUrl)).toEqual([
      "https://github.com/sample/my-repo",
    ]);
  });
});

test.each([
  "http://github.com/sample/repo",
  "https://github.com/sample",
  "https://token@github.com/sample/repo",
  "not a url",
  "",
])("refuses %j as a repository to connect", async (repositoryUrl) => {
  await withProjects(`catalog-refuses-${repositoryUrl.length}`, (projects) => {
    expect(projects.connect({ repositoryUrl }, NOW)).toEqual({
      ok: false,
      problem: { code: "invalid-repository-url" },
    });
    expect(projects.list()).toEqual([]);
  });
});

test("names a project after its repository when nobody chooses a name", async () => {
  await withProjects("catalog-default-name", (projects) => {
    projects.connect({ repositoryUrl: "https://github.com/sample/repo-1", displayName: "  " }, NOW);

    expect(projects.list()[0]).toEqual({
      id: "sample-repo-1",
      displayName: "sample/repo-1",
      repositoryUrl: "https://github.com/sample/repo-1",
      connectedAt: NOW,
    });
  });
});

test("one tenant's project is unknown to another tenant", async () => {
  await withProjects("catalog-tenant-one", (projects) => {
    projects.connect({ repositoryUrl: "https://github.com/sample/private-repo" }, NOW);
    expect(projects.catalog().map((project) => project.id)).toEqual(["sample-private-repo"]);
  });

  await withProjects("catalog-tenant-two", (projects) => {
    expect(
      resolveProject("sample-private-repo", projects.catalog()),
      "a catalog belongs to one Supervisor, which is one tenant",
    ).toEqual({ ok: false, reason: "unknown-project-id" });
  });
});

test("a disconnected project leaves the catalog and stops resolving", async () => {
  await withProjects("catalog-disconnect", (projects) => {
    const connected = projects.connect({ repositoryUrl: "https://github.com/sample/repo-1" }, NOW);
    if (!connected.ok) {
      throw new Error("this repository must connect");
    }

    projects.disconnect(connected.project.id);

    expect(projects.catalog()).toEqual([]);
    expect(resolveProject(connected.project.id, projects.catalog())).toEqual({
      ok: false,
      reason: "unknown-project-id",
    });
  });
});
