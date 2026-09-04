import { expect, test } from "vitest";
import {
  PROJECT_CATALOG,
  PROJECT_CATALOG_CONFIGURATION,
  parseProjectCatalog,
} from "../src/project-catalog.js";
import { resolveProjectWorkspaceName } from "../src/workspace-names.js";

const tenant = { identity: "tenant-1", audience: "test-audience" } as const;

test("configures exactly two projects with validated repository URLs", () => {
  expect(PROJECT_CATALOG).toHaveLength(2);
  expect(parseProjectCatalog(PROJECT_CATALOG_CONFIGURATION)).toEqual(PROJECT_CATALOG);
  expect(
    PROJECT_CATALOG.every((project) => project.repositoryUrl.includes("example.invalid")),
  ).toBe(true);
});

test("resolves the two configured projects to different workspace names", async () => {
  const first = await resolveProjectWorkspaceName({
    ...tenant,
    projectId: PROJECT_CATALOG[0].id,
  });
  const second = await resolveProjectWorkspaceName({
    ...tenant,
    projectId: PROJECT_CATALOG[1].id,
  });

  if (!first.ok || !second.ok) {
    throw new Error("configured projects must resolve");
  }
  expect(first.workspaceName).not.toBe(second.workspaceName);
});

test("rejects an unknown client-supplied project id before deriving a workspace", async () => {
  await expect(
    resolveProjectWorkspaceName({ ...tenant, projectId: "client-supplied-project" }),
  ).resolves.toEqual({ ok: false, reason: "unknown-project-id" });
});

test("keeps a project workspace name stable for the same tenant and project", async () => {
  const projectId = PROJECT_CATALOG[0].id;
  const first = await resolveProjectWorkspaceName({ ...tenant, projectId });
  const second = await resolveProjectWorkspaceName({ ...tenant, projectId });

  if (!first.ok || !second.ok) {
    throw new Error("configured projects must resolve");
  }
  expect(first.workspaceName).toBe(second.workspaceName);
});

test("rejects malformed repository configuration", () => {
  expect(
    parseProjectCatalog([
      {
        id: "project-one",
        displayName: "Project one",
        repositoryUrl: "http://example.invalid/project-one.git",
      },
      PROJECT_CATALOG_CONFIGURATION[1],
    ]),
  ).toBeUndefined();
});
