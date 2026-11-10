import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { ownerSession } from "../integration/owner-session.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import { replaceWorkspaceHost } from "../workspace-host-spy.js";
import type { WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

function spyOnWorkspaceLookups() {
  return replaceWorkspaceHost<
    Omit<WorkspaceHostRpc, "project" | "reset" | "backend" | "setBackend">
  >(env.WORKSPACE_HOST, new FakeTenantWorkspace());
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test.each(["/api/status", "/api/projects", "/api/github/connection", "/api/chatgpt/connection"])(
  "GET %s is record-only: the real Supervisor answers it without asking for the workspace",
  async (path) => {
    const hostLookups = spyOnWorkspaceLookups();

    const response = await ownerSession().get(path);

    expect(response.status).toBe(200);
    expect(hostLookups).not.toHaveBeenCalled();
  },
);

test("the workspace lookup the record-only routes avoid is one a workspace route makes", async () => {
  const hostLookups = spyOnWorkspaceLookups();

  await ownerSession().post("/api/github/connection/refresh");

  expect(hostLookups).toHaveBeenCalled();
});

test("an unknown route answers 404 without asking for the workspace", async () => {
  const hostLookups = spyOnWorkspaceLookups();

  const response = await ownerSession().get("/api/projects/sample-project-one/rename");

  expect(response.status).toBe(404);
  expect(hostLookups).not.toHaveBeenCalled();
});
