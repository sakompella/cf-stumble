import { expect, test } from "vitest";
import { deriveSupervisorName } from "../src/access/index.js";
import { tenantWorkspaceName } from "../src/workspace-names.js";

/**
 * One tenant, one workspace (ADR-0038). The tenant key is the Supervisor's own name, which the
 * Worker derives from the verified Access identity and audience, so these tests derive it the same
 * way rather than inventing a second opinion of who a tenant is.
 */

const audience = "workspace-name-audience";

function nameFor(identity: string): Promise<string> {
  return deriveSupervisorName({ identity, audience });
}

test("gives different tenants different workspaces and keeps one tenant stable", async () => {
  const ownerWorkspace = tenantWorkspaceName(await nameFor("owner-1"));
  const otherWorkspace = tenantWorkspaceName(await nameFor("owner-2"));

  expect(ownerWorkspace).toBe(tenantWorkspaceName(await nameFor("owner-1")));
  expect(otherWorkspace).not.toBe(ownerWorkspace);
});

test("refuses to name a workspace without a tenant key", () => {
  expect(() => tenantWorkspaceName("")).toThrow(
    "a tenant workspace name needs a server-derived tenant key",
  );
});
