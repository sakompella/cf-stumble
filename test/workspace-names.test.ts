import { expect, test } from "vitest";
import { deriveSupervisorName } from "../src/access/index.js";
import { tenantWorkspaceName } from "../src/workspace-names.js";
import { sampleCatalog, sampleProjectOne, sampleProjectTwo } from "./project-fixtures.js";
import { projectDirectory } from "../src/workspace-layout.js";

/**
 * One tenant, one workspace (ADR-0038). The tenant key is the Supervisor's own name, which the
 * Worker derives from the verified Access identity and audience, so these tests derive it the same
 * way rather than inventing a second opinion of who a tenant is.
 */

const audience = "workspace-name-audience";

function nameFor(identity: string): Promise<string> {
  return deriveSupervisorName({ identity, audience });
}

test("harness builds and every project of one tenant select the same workspace", async () => {
  const workspace = tenantWorkspaceName(await nameFor("owner-1"));

  expect(tenantWorkspaceName(await nameFor("owner-1"))).toBe(workspace);
  expect(
    sampleCatalog.map((project) => projectDirectory(project.id)),
    "a project selects a directory inside that one workspace, not a workspace of its own",
  ).toEqual([
    `/workspace/projects/${sampleProjectOne.id}`,
    `/workspace/projects/${sampleProjectTwo.id}`,
  ]);
});

test("carries no project id, so no project can name a workspace of its own", async () => {
  const workspace = tenantWorkspaceName(await nameFor("owner-1"));

  for (const project of sampleCatalog) {
    expect(workspace).not.toContain(project.id);
  }
});

test("refuses to name a workspace without a tenant key", () => {
  expect(() => tenantWorkspaceName("")).toThrow(
    "a tenant workspace name needs a server-derived tenant key",
  );
});
