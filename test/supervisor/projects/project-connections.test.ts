import { reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import { HARNESS_PROJECT } from "../../../src/selectable-projects.js";
import { FAKE_TOKEN, NOW, REPOSITORY, tenant } from "./connection-tenant.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("connects a repository once the workspace credential works, and provisions it", async () => {
  const subject = tenant("connect-with-fallback", { fallbackToken: FAKE_TOKEN });

  const connected = await subject.connections((connections) =>
    connections.connect(REPOSITORY, "Repo one", NOW),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(connected).toMatchObject({
    ok: true,
    alreadyConnected: false,
    project: { id: "sample-repo-1", displayName: "Repo one", repositoryUrl: REPOSITORY },
    github: { state: "connected", login: "octocat", source: "configured-token" },
  });
  expect(listed.map((project) => project.id)).toEqual(["sample-repo-1", "harness"]);
  expect(
    subject.workspace.commands.filter((command) => command.includes("git clone")),
    "connecting provisions the repository it just verified",
  ).toHaveLength(1);
});

test("a third repository joins the same one workspace, not a workspace of its own", async () => {
  const subject = tenant("connect-three", { fallbackToken: FAKE_TOKEN });

  for (const suffix of ["one", "two", "three"]) {
    const connected = await subject.connections((connections) =>
      connections.connect(`https://github.com/sample/repo-${suffix}`, undefined, NOW),
    );

    expect(connected).toMatchObject({ ok: true });
  }

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(listed.map((project) => project.id)).toEqual([
    "sample-repo-one",
    "sample-repo-three",
    "sample-repo-two",
    "harness",
  ]);
  expect(
    [...new Set(subject.workspace.names)],
    "every project reaches the tenant's one workspace (ADR-0038)",
  ).toEqual([tenantWorkspaceName("connect-three")]);
});

test("keeps a repository the workspace cannot read out of the catalog", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.repositoryAccess = "denied";
  const subject = tenant("connect-denied", { workspace, fallbackToken: FAKE_TOKEN });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "repository-not-accessible" } });
  expect(listed, "nothing was connected, so the harness entry is the whole list").toEqual([
    HARNESS_PROJECT,
  ]);
  expect(
    subject.workspace.commands.some((command) => command.includes("git clone")),
    "a repository is verified before anything is cloned",
  ).toBe(false);
});

test("maps a clone disk failure to repository-too-large", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.cloneExitCode = 122;
  const subject = tenant("connect-clone-disk-fails", { workspace, fallbackToken: FAKE_TOKEN });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "repository-too-large" } });
});

test("takes a project back out when its clone fails, so a listed project has files", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.cloneExitCode = 128;
  const subject = tenant("connect-clone-fails", { workspace, fallbackToken: FAKE_TOKEN });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "provisioning-failed" } });
  expect(listed).toEqual([HARNESS_PROJECT]);
});

test("lists the harness with no connection, and clones nothing for it", async () => {
  const subject = tenant("harness-entry", { fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, "Repo one", NOW));

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  const harness = listed.find((project) => project.kind === "harness");

  expect(harness).toEqual(HARNESS_PROJECT);
  expect(harness).not.toHaveProperty("repositoryUrl");
  expect(
    subject.workspace.commands.filter((command) => command.includes("git clone")),
    "only the connected repository was cloned; the harness checkout is already there",
  ).toHaveLength(1);
});

test("refuses a repository URL that once reduced to the harness entry's id", async () => {
  const subject = tenant("harness-id-taken", { fallbackToken: FAKE_TOKEN });

  const refused = await subject.connections((connections) =>
    connections.connect("https://github.com/-/harness", undefined, NOW),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "invalid-repository-url" } });
  expect(listed).toEqual([HARNESS_PROJECT]);
  expect(
    subject.workspace.commands.filter((command) => command.includes("https://github.com/-/")),
    "a URL that derives no project id is never handed to the workspace",
  ).toEqual([]);
});

test("disconnects a project row and removes its clone through the narrow workspace step", async () => {
  const subject = tenant("disconnect-project", { fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, undefined, NOW));

  const disconnected = await subject.connections((connections) =>
    connections.disconnect("sample-repo-1", () => true),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(disconnected).toEqual({
    ok: true,
    projectId: "sample-repo-1",
    workspace: "removed",
  });
  expect(listed).toEqual([HARNESS_PROJECT]);
  const removal = subject.workspace.commands.find((command) => command.includes("rm -rf"));
  expect(removal).toContain("/workspace/projects/sample-repo-1");
  expect(removal).toContain("/workspace/projects/sample-repo-1.provisioning");
  expect(removal).not.toContain("/workspace/harness");
});

test("removes the project row when workspace cleanup fails", async () => {
  const subject = tenant("disconnect-workspace-fails", { fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, undefined, NOW));
  subject.workspace.unavailable = true;

  const disconnected = await subject.connections((connections) =>
    connections.disconnect("sample-repo-1", () => true),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(disconnected).toEqual({
    ok: true,
    projectId: "sample-repo-1",
    workspace: "failed",
  });
  expect(listed).toEqual([HARNESS_PROJECT]);
});

test("reports a removal that the durable store does not show as failed, not removed", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const subject = tenant("disconnect-sync-incomplete", { fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, undefined, NOW));
  subject.workspace.commandSync = "incomplete";

  const disconnected = await subject.connections((connections) =>
    connections.disconnect("sample-repo-1", () => true),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(disconnected).toEqual({ ok: true, projectId: "sample-repo-1", workspace: "failed" });
  expect(listed).toEqual([HARNESS_PROJECT]);
});

test("keeps a repository whose clone the durable store does not show out of the catalog", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const workspace = new FakeTenantWorkspace();
  workspace.commandSync = "incomplete";
  const subject = tenant("connect-sync-incomplete", { workspace, fallbackToken: FAKE_TOKEN });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "provisioning-failed" } });
  expect(listed).toEqual([HARNESS_PROJECT]);
});
