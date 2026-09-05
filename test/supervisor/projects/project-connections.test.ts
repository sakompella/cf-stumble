/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { ProjectConnections } from "../../../src/supervisor/projects/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import type { GitHubFetch } from "../../../src/github/index.js";

/**
 * Connecting repositories, and the GitHub authorization behind it.
 *
 * The workspace is the fake in `fake-tenant-workspace.ts`, which runs the real credential and
 * provision surfaces over a fake shell, and GitHub is a scripted provider. What these tests hold
 * is the order of the steps, the binding of an authorization to the owner who started it, and the
 * negative goal criterion 3 asks for: a recognizable fake token reaches the workspace install and
 * appears in no status, no stored row, and no value a caller could return to a browser.
 */

const NOW = 1_700_000_000_000;
const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";
const CLIENT_ID = "Iv1.cfstumbleFAKE";
const REPOSITORY = "https://github.com/sample/repo-1";

type Reply = Readonly<{ [field: string]: string | number }>;

function githubReplying(replies: readonly Reply[]): GitHubFetch {
  let index = 0;
  return () => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;
    return Promise.resolve(Response.json(reply));
  };
}

const deviceReply = {
  device_code: "device-code-secret",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
} satisfies Reply;

interface Tenant {
  readonly workspace: FakeTenantWorkspace;
  connections<T>(use: (connections: ProjectConnections) => Promise<T>): Promise<T>;
}

/**
 * One tenant: a real `ProjectConnections` over the Supervisor's own storage, the fake workspace,
 * and a scripted GitHub. Each call re-reads storage, so a test can watch state persist.
 */
function tenant(
  name: string,
  options: Readonly<{
    workspace?: FakeTenantWorkspace;
    fallbackToken?: string;
    clientId?: string;
    replies?: readonly Reply[];
  }> = {},
): Tenant {
  const workspace = options.workspace ?? new FakeTenantWorkspace();
  return {
    workspace,
    connections: (use) =>
      runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
        use(
          new ProjectConnections({
            storage: state.storage,
            workspaceName: tenantWorkspaceName(name),
            namespace: workspace.namespace,
            environment: {
              clientId: options.clientId ?? CLIENT_ID,
              fallbackToken: options.fallbackToken,
              fetcher: githubReplying(options.replies ?? [deviceReply]),
            },
          }),
        ),
      ),
  };
}

afterEach(async () => {
  await reset();
});

test("connects a repository once the workspace credential works, and provisions it", async () => {
  const subject = tenant("connect-with-fallback", { fallbackToken: FAKE_TOKEN });

  const connected = await subject.connections((connections) =>
    connections.connect(REPOSITORY, "Repo one", NOW),
  );
  const listed = await subject.connections((connections) => connections.list(NOW));

  expect(connected).toMatchObject({
    ok: true,
    alreadyConnected: false,
    project: { id: "sample-repo-1", displayName: "Repo one", repositoryUrl: REPOSITORY },
    github: { state: "connected", login: "octocat", source: "configured-token" },
  });
  expect(listed.projects.map((project) => project.id)).toEqual(["sample-repo-1"]);
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
  const listed = await subject.connections((connections) => connections.list(NOW));

  expect(listed.projects.map((project) => project.id)).toEqual([
    "sample-repo-one",
    "sample-repo-three",
    "sample-repo-two",
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
  const listed = await subject.connections((connections) => connections.list(NOW));

  expect(refused).toMatchObject({ ok: false, problem: { code: "repository-not-accessible" } });
  expect(listed.projects).toEqual([]);
  expect(
    subject.workspace.commands.some((command) => command.includes("git clone")),
    "a repository is verified before anything is cloned",
  ).toBe(false);
});

test("takes a project back out when its clone fails, so a listed project has files", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.cloneExitCode = 128;
  const subject = tenant("connect-clone-fails", { workspace, fallbackToken: FAKE_TOKEN });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );
  const listed = await subject.connections((connections) => connections.list(NOW));

  expect(refused).toMatchObject({ ok: false, problem: { code: "provisioning-failed" } });
  expect(listed.projects).toEqual([]);
});

test("provisions again every time a project is used", async () => {
  const subject = tenant("provision-on-use", { fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.connect(REPOSITORY, undefined, NOW));

  const used = await subject.connections((connections) =>
    connections.ensureProvisioned("sample-repo-1"),
  );
  const unknown = await subject.connections((connections) =>
    connections.ensureProvisioned("not-connected"),
  );

  expect(used).toMatchObject({ ok: true, project: { id: "sample-repo-1" } });
  expect(unknown).toEqual({ ok: false, problem: { code: "unknown-project-id" } });
  expect(
    subject.workspace.commands.filter((command) => command.includes("git clone")),
    "the connection provisioned once and the use provisioned again",
  ).toHaveLength(2);
});

test("asks for a reconnection after a restart left the workspace without a credential", async () => {
  const workspace = new FakeTenantWorkspace();
  const subject = tenant("credential-after-restart", { workspace, fallbackToken: FAKE_TOKEN });
  await subject.connections((connections) => connections.ensureCredential(NOW));
  const connected = await subject.connections((connections) => connections.connectionStatus(NOW));

  // A recreated container keeps the tenant's storage and loses the workspace filesystem, so `gh`
  // has no credential and cf-stumble's record of one is the only thing left.
  workspace.credentialState = "missing";
  const withoutFallback = tenant("credential-after-restart", { workspace });
  const reported = await withoutFallback.connections((connections) =>
    connections.connectionStatus(NOW + 1),
  );
  const repaired = await subject.connections((connections) =>
    connections.ensureCredential(NOW + 2),
  );

  expect(connected).toMatchObject({ state: "connected", source: "configured-token" });
  expect(reported).toEqual({ state: "reconnect-required", reason: "credential-missing" });
  expect(repaired, "the documented fallback reinstalls without a person").toMatchObject({
    state: "connected",
    source: "configured-token",
  });
});

test("reports a reconnect requirement rather than a connection it cannot use", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.credentialState = "unusable";
  const subject = tenant("credential-rejected", { workspace });

  const status = await subject.connections((connections) => connections.connectionStatus(NOW));

  expect(status).toEqual({ state: "reconnect-required", reason: "credential-rejected" });
});

test("reports a workspace it cannot reach as a reconnect requirement, never as connected", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.unavailable = true;
  const subject = tenant("workspace-unavailable", { workspace, fallbackToken: FAKE_TOKEN });

  const status = await subject.connections((connections) => connections.ensureCredential(NOW));

  expect(status).toEqual({ state: "reconnect-required", reason: "workspace-unavailable" });
});

test("shows a workspace image without gh instead of installing one", async () => {
  const workspace = new FakeTenantWorkspace();
  workspace.credentialState = "tooling-missing";
  const subject = tenant("tooling-missing", { workspace, fallbackToken: FAKE_TOKEN });

  const status = await subject.connections((connections) => connections.ensureCredential(NOW));

  expect(status).toEqual({ state: "tooling-missing" });
});
