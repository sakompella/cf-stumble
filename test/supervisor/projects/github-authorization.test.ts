/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { ProjectConnections } from "../../../src/supervisor/projects/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import type { GitHubFetch } from "../../../src/github/index.js";
import type { VerifiedAccessScope } from "../../../src/access/index.js";

/**
 * The owner-initiated GitHub device authorization (ADR-0039, Q2).
 *
 * The application shows a verification URL and a short user code and nothing else. The device code
 * that redeems the authorization stays server-side, the redemption is bound to the owner who
 * started it, and a consumed or expired authorization cannot be redeemed again. The token itself
 * exists for one call: these tests follow the recognizable fake token and show where it goes.
 */

const NOW = 1_700_000_000_000;

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

const CLIENT_ID = "Iv1.cfstumbleFAKE";

const owner: VerifiedAccessScope = { identity: "owner-subject", audience: "owner-audience" };

const otherOwner: VerifiedAccessScope = { identity: "someone-else", audience: "owner-audience" };

type Reply = Readonly<{ [field: string]: string | number }>;

const deviceReply = {
  device_code: "device-code-secret",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
} satisfies Reply;

function githubReplying(replies: readonly Reply[]): GitHubFetch {
  let index = 0;

  return () => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;

    return Promise.resolve(Response.json(reply));
  };
}

interface Tenant {
  readonly workspace: FakeTenantWorkspace;
  connections<T>(use: (connections: ProjectConnections) => Promise<T>): Promise<T>;
}

/** `configured` is false for the deployment that has no GitHub OAuth client id yet. */
function tenant(name: string, replies: readonly Reply[], configured = true): Tenant {
  const clientId = configured ? CLIENT_ID : undefined;
  const workspace = new FakeTenantWorkspace();
  const fetcher = githubReplying(replies);

  return {
    workspace,
    connections: (use) =>
      runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
        use(
          new ProjectConnections({
            storage: state.storage,
            workspaceName: tenantWorkspaceName(name),
            namespace: workspace.namespace,
            environment: { clientId, fallbackToken: undefined, fetcher },
          }),
        ),
      ),
  };
}

afterEach(async () => {
  await reset();
});

test("shows the verification page and the user code, and never the device code", async () => {
  const subject = tenant("authorization-start", [deviceReply]);

  const started = await subject.connections((connections) =>
    connections.startAuthorization(owner, NOW),
  );

  const status = await subject.connections((connections) => connections.connectionStatus(NOW));

  expect(started).toEqual({
    ok: true,
    status: {
      state: "awaiting-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
      expiresAt: NOW + 900_000,
      intervalSeconds: 5,
    },
  });
  expect(JSON.stringify(status)).not.toContain("device-code-secret");
});

test("installs the token into the workspace and returns a status without it", async () => {
  const subject = tenant("authorization-completes", [
    deviceReply,
    { access_token: FAKE_TOKEN, token_type: "bearer" },
  ]);

  await subject.connections((connections) => connections.startAuthorization(owner, NOW));

  const completed = await subject.connections((connections) =>
    connections.completeAuthorization(owner, NOW + 1_000),
  );

  expect(completed).toEqual({
    ok: true,
    status: { state: "connected", login: "octocat", source: "device-authorization" },
  });
  expect(
    subject.workspace.credentialRequests.filter((sent) => sent.includes(FAKE_TOKEN)),
    "the token reaches the workspace install and nothing else",
  ).toHaveLength(1);
  expect(JSON.stringify(completed)).not.toContain(FAKE_TOKEN);
});

test("keeps waiting while the owner is still at GitHub's page", async () => {
  const subject = tenant("authorization-pending", [
    deviceReply,
    { error: "authorization_pending" },
  ]);

  await subject.connections((connections) => connections.startAuthorization(owner, NOW));

  const polled = await subject.connections((connections) =>
    connections.completeAuthorization(owner, NOW + 1_000),
  );

  expect(polled).toMatchObject({ ok: true, status: { state: "awaiting-authorization" } });
});

test("refuses a redemption by any owner other than the one that started it", async () => {
  const subject = tenant("authorization-other-owner", [deviceReply, { access_token: FAKE_TOKEN }]);
  await subject.connections((connections) => connections.startAuthorization(owner, NOW));

  const refused = await subject.connections((connections) =>
    connections.completeAuthorization(otherOwner, NOW + 1_000),
  );

  const stillWaiting = await subject.connections((connections) =>
    connections.connectionStatus(NOW + 1_000),
  );

  expect(refused).toEqual({ ok: false, problem: "not-the-initiating-owner" });
  expect(stillWaiting).toMatchObject({ state: "awaiting-authorization" });
  expect(subject.workspace.credentialRequests.join("")).not.toContain(FAKE_TOKEN);
});

test("redeems one authorization once, so a replayed completion finds nothing", async () => {
  const subject = tenant("authorization-replay", [deviceReply, { access_token: FAKE_TOKEN }]);
  await subject.connections((connections) => connections.startAuthorization(owner, NOW));

  const first = await subject.connections((connections) =>
    connections.completeAuthorization(owner, NOW + 1_000),
  );

  const replayed = await subject.connections((connections) =>
    connections.completeAuthorization(owner, NOW + 2_000),
  );

  expect(first).toMatchObject({ ok: true });
  expect(replayed).toEqual({ ok: false, problem: "no-pending-authorization" });
});

test.each([
  [{ error: "expired_token" }, "authorization-expired"],
  [{ error: "access_denied" }, "authorization-denied"],
])("ends the authorization when GitHub answers %j", async (reply, problem) => {
  const subject = tenant(`authorization-${problem}`, [deviceReply, reply]);
  await subject.connections((connections) => connections.startAuthorization(owner, NOW));

  const ended = await subject.connections((connections) =>
    connections.completeAuthorization(owner, NOW + 1_000),
  );

  const afterwards = await subject.connections((connections) =>
    connections.connectionStatus(NOW + 1_000),
  );

  expect(ended).toEqual({ ok: false, problem });
  expect(afterwards).toEqual({ state: "disconnected" });
});

test("drops an authorization the owner never finished, rather than keeping the code", async () => {
  const subject = tenant("authorization-expires", [deviceReply, { access_token: FAKE_TOKEN }]);
  await subject.connections((connections) => connections.startAuthorization(owner, NOW));

  const afterWindow = await subject.connections((connections) =>
    connections.completeAuthorization(owner, NOW + 900_001),
  );

  expect(afterWindow).toEqual({ ok: false, problem: "no-pending-authorization" });
});

test("refuses to start without a configured GitHub OAuth client", async () => {
  const subject = tenant("authorization-unconfigured", [deviceReply], false);

  const started = await subject.connections((connections) =>
    connections.startAuthorization(owner, NOW),
  );

  expect(started).toEqual({ ok: false, problem: "not-configured" });
});
