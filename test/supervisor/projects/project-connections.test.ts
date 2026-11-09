import { reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import { HARNESS_PROJECT } from "../../../src/selectable-projects.js";
import { FAKE_TOKEN, noRunActive, NOW, REPOSITORY, tenant } from "./connection-tenant.js";

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

  for (const [offset, suffix] of ["one", "two", "three"].entries()) {
    const connected = await subject.connections((connections) =>
      connections.connect(`https://github.com/sample/repo-${suffix}`, undefined, NOW + offset),
    );

    expect(connected).toMatchObject({ ok: true });
  }

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(listed.map((project) => project.id)).toEqual([
    "sample-repo-one",
    "sample-repo-two",
    "sample-repo-three",
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

test("disconnecting a project removes its clone and leaves the harness checkout", async () => {
  const workspace = new FakeTenantWorkspace();
  const subject = tenant("disconnect-project", { workspace, fallbackToken: FAKE_TOKEN });

  await workspace.build({
    kind: "build-step",
    harnessCommit: testHarnessCommit("1".repeat(40)),
    step: "provision",
  });
  await subject.connections((connections) => connections.connect(REPOSITORY, undefined, NOW));
  expect(await workspace.lstat("/workspace/projects/sample-repo-1")).toBe("directory");

  const disconnected = await subject.connections((connections) =>
    connections.disconnect("sample-repo-1", noRunActive),
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
  expect(await workspace.lstat("/workspace/projects/sample-repo-1")).toBeUndefined();
  expect(await workspace.lstat("/workspace/harness")).toBe("directory");
});

test.each([
  {
    outcome: "the workspace is unavailable",
    arrange: (workspace: FakeTenantWorkspace) => {
      workspace.unavailable = true;
    },
  },
  {
    outcome: "the durable store does not show the removal",
    arrange: (workspace: FakeTenantWorkspace) => {
      workspace.commandSync = "incomplete";
    },
  },
])("removes the project row and reports the clone as failed when $outcome", async (row) => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  const subject = tenant(`disconnect-${row.outcome.replaceAll(" ", "-")}`, {
    fallbackToken: FAKE_TOKEN,
  });

  await subject.connections((connections) => connections.connect(REPOSITORY, undefined, NOW));
  row.arrange(subject.workspace);

  const disconnected = await subject.connections((connections) =>
    connections.disconnect("sample-repo-1", noRunActive),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(disconnected).toEqual({ ok: true, projectId: "sample-repo-1", workspace: "failed" });
  expect(listed).toEqual([HARNESS_PROJECT]);
});
