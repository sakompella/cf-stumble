import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { SupervisorWorkspaceHost } from "../../src/supervisor/supervisor-env.js";
import { routeClass, routePattern } from "../../src/routes/route-pattern.js";
import { ownerSession } from "../integration/owner-session.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import { replaceWorkspaceHost } from "../workspace-host-spy.js";

function spyOnWorkspaceLookups() {
  return replaceWorkspaceHost<Omit<SupervisorWorkspaceHost, "project" | "reset">>(
    env.WORKSPACE_HOST,
    new FakeTenantWorkspace(),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const classOf = (path: string) => routeClass(routePattern(path));

test.each(["/api/status", "/api/projects", "/api/github/connection", "/api/chatgpt/connection"])(
  "GET %s is record-only: the real Supervisor answers it without asking for the workspace",
  async (path) => {
    const hostLookups = spyOnWorkspaceLookups();

    expect(classOf(path)).toBe("record-only");

    const response = await ownerSession().get(path);

    expect(response.status).toBe(200);
    expect(hostLookups).not.toHaveBeenCalled();
  },
);

test("the workspace lookup the record-only routes avoid is one a workspace route makes", async () => {
  const hostLookups = spyOnWorkspaceLookups();

  expect(classOf("/api/github/connection/refresh")).toBe("workspace");

  await ownerSession().post("/api/github/connection/refresh");

  expect(hostLookups).toHaveBeenCalled();
});

test("a route the table does not list is record-only", () => {
  expect(classOf("/api/projects/sample-project-one/rename")).toBe("record-only");
});
