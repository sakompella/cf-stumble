import { reset } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { afterEach, expect, test } from "vitest";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import { projectIdOf } from "../../project-fixtures.js";
import { FAKE_TOKEN, NOW, REPOSITORY, tenant } from "./connection-tenant.js";

afterEach(async () => {
  await reset();
});

test("refuses provisioning on use when the clone's sync does not complete", async () => {
  const subject = tenant("use-sync-incomplete", { fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, NOW));
  subject.workspace.commandSync = "incomplete";
  subject.workspace.loseClone();

  const used = await subject.connections((connections) =>
    connections.ensureProvisioned(projectIdOf("sample-repo-1")),
  );

  expect(used).toEqual({
    ok: false,
    problem: { code: "host-unavailable", detail: "workspace-sync-incomplete" },
  });
});

test("provisions again every time a project is used", async () => {
  const subject = tenant("provision-on-use", { fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, NOW));

  const used = await subject.connections((connections) =>
    connections.ensureProvisioned(projectIdOf("sample-repo-1")),
  );

  const unknown = await subject.connections((connections) =>
    connections.ensureProvisioned(projectIdOf("not-connected")),
  );

  expect(used).toMatchObject({ ok: true, project: { id: "sample-repo-1" } });
  expect(unknown).toEqual({ ok: false, problem: { code: "unknown-project-id", detail: "" } });
  expect(
    subject.workspace.provisionRequests.map((request) => request.projectId),
    "the connection provisioned once and the use provisioned again",
  ).toEqual(["sample-repo-1", "sample-repo-1"]);
});

test("keeps a project whose reprovision the clone size check refuses", async () => {
  const workspace = new FakeTenantWorkspace();
  const subject = tenant("reprovision-too-large", { workspace, fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, NOW));

  workspace.cloneSizeVerdict = "working-tree-too-large";
  workspace.loseClone();

  const used = await subject.connections((connections) =>
    connections.ensureProvisioned(projectIdOf("sample-repo-1")),
  );

  const listed = await subject.connections((connections) =>
    Effect.sync(() => connections.catalog()),
  );

  expect(used).toEqual({
    ok: false,
    problem: { code: "repository-too-large", detail: "working-tree-too-large" },
  });
  expect(listed.map((project) => project.id)).toContain("sample-repo-1");
});

test("a clone that fails after a reset succeeds once the configured credential is reinstalled", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.cloneNeedsCredential = true;
  const subject = tenant("credential-after-failed-clone", { workspace, fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, NOW));

  await subject.github((github) =>
    Effect.sync(() => {
      github.resetWorkspace();
    }),
  );
  workspace.credentialState = "missing";
  workspace.loseClone();

  const used = await subject.connections((connections) =>
    connections.ensureProvisioned(projectIdOf("sample-repo-1")),
  );

  expect(used).toMatchObject({ ok: true });
  expect(workspace.credentialState).toBe("connected");
});

test("a turn whose clone is in place runs no credential command", async () => {
  const workspace = new FakeTenantWorkspace();
  const subject = tenant("no-credential-check-per-turn", { workspace, fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, NOW));
  const requestsBeforeUse = workspace.credentialRequests.length;

  const used = await subject.connections((connections) =>
    connections.ensureProvisioned(projectIdOf("sample-repo-1")),
  );

  expect(used).toMatchObject({ ok: true });
  expect(workspace.credentialRequests).toHaveLength(requestsBeforeUse);
});

test("still attempts the clone without a credential, so a public repository re-clones after a reset", async () => {
  const workspace = new FakeTenantWorkspace();

  const subject = tenant("credential-required-before-use", {
    workspace,
    fallbackToken: FAKE_TOKEN,
  });

  await subject.connections((connections) => connections.connect(REPOSITORY, NOW));

  await subject.github((github) =>
    Effect.sync(() => {
      github.resetWorkspace();
    }),
  );
  workspace.credentialState = "missing";
  workspace.loseClone();
  const withoutFallback = tenant("credential-required-before-use", { workspace });

  const used = await withoutFallback.connections((connections) =>
    connections.ensureProvisioned(projectIdOf("sample-repo-1")),
  );

  expect(used).toMatchObject({ ok: true, project: { id: "sample-repo-1" } });
  expect(await workspace.lstat("/workspace/projects/sample-repo-1")).toBe("directory");
  expect(workspace.credentialState).toBe("missing");
});

test("asks for a reconnection after a restart left the workspace without a credential", async () => {
  const workspace = new FakeTenantWorkspace();
  const subject = tenant("credential-after-restart", { workspace, fallbackToken: FAKE_TOKEN });
  await subject.github((github) => github.ensureCredential(NOW));
  const connected = await subject.github((github) => github.status(NOW));

  workspace.credentialState = "missing";
  const withoutFallback = tenant("credential-after-restart", { workspace });

  const reported = await withoutFallback.github((github) => github.status(NOW + 1));

  const repaired = await subject.github((github) => github.ensureCredential(NOW + 2));

  expect(connected).toMatchObject({ state: "connected", source: "configured-token" });
  expect(reported).toEqual({ state: "reconnect-required", reason: "credential-missing" });
  expect(repaired, "the documented fallback reinstalls without a person").toMatchObject({
    state: "connected",
    source: "configured-token",
  });
});

test("clears cached GitHub status after resetting the workspace", async () => {
  const workspace = new FakeTenantWorkspace();
  const subject = tenant("reset-clears-connection", { workspace, fallbackToken: FAKE_TOKEN });

  await subject.github((github) => github.ensureCredential(NOW));
  await subject.github((github) =>
    Effect.sync(() => {
      github.resetWorkspace();
    }),
  );
  workspace.credentialState = "missing";

  await expect(
    subject.github((github) => Effect.sync(() => github.lastKnown(NOW + 1))),
  ).resolves.toEqual({ github: null, checkedAt: null });
  await expect(subject.github((github) => github.status(NOW + 1))).resolves.toEqual({
    state: "disconnected",
  });

  await expect(subject.github((github) => github.ensureCredential(NOW + 2))).resolves.toMatchObject(
    { state: "connected", source: "configured-token" },
  );
});

test("reports a reconnect requirement rather than a connection it cannot use", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.credentialState = "unusable";
  const subject = tenant("credential-rejected", { workspace });

  const status = await subject.github((github) => github.status(NOW));

  expect(status).toEqual({ state: "reconnect-required", reason: "credential-rejected" });
});

const CONNECTED_AT_NOW = {
  github: { state: "connected", login: "octocat", source: "configured-token" },
  checkedAt: NOW,
};

test("a check that cannot reach the workspace leaves a connected credential connected", async () => {
  const workspace = new FakeTenantWorkspace();
  const subject = tenant("workspace-unavailable", { workspace, fallbackToken: FAKE_TOKEN });
  await subject.github((github) => github.ensureCredential(NOW));
  workspace.unavailable = true;

  const checked = await subject.github((github) => Effect.result(github.ensureCredential(NOW + 1)));

  expect(Result.isFailure(checked), "the check answers that it could not run").toBe(true);
  await expect(
    subject.github((github) => Effect.sync(() => github.lastKnown(NOW + 2))),
  ).resolves.toEqual(CONNECTED_AT_NOW);
});

test("a check that GitHub answered no verdict to leaves a connected credential connected", async () => {
  const workspace = new FakeTenantWorkspace();
  const subject = tenant("github-unreachable", { workspace, fallbackToken: FAKE_TOKEN });
  await subject.github((github) => github.ensureCredential(NOW));
  workspace.credentialState = "unreachable";

  const checked = await subject.github((github) => Effect.result(github.status(NOW + 1)));

  expect(Result.isFailure(checked), "no verdict is not a rejection").toBe(true);
  await expect(
    subject.github((github) => Effect.sync(() => github.lastKnown(NOW + 2))),
  ).resolves.toEqual(CONNECTED_AT_NOW);
});

test("shows a workspace image without gh instead of installing one", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.credentialState = "tooling-missing";
  const subject = tenant("tooling-missing", { workspace, fallbackToken: FAKE_TOKEN });

  const status = await subject.github((github) => github.ensureCredential(NOW));

  expect(status).toEqual({ state: "tooling-missing" });
});
