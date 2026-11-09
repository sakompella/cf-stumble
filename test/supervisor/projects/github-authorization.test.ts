import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import { afterEach, expect, test } from "vitest";
import { GitHubConnection, GitHubConnectionStore } from "../../../src/supervisor/projects/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import type { GitHubFetch } from "../../../src/github/index.js";

const NOW = 1_700_000_000_000;

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

const CLIENT_ID = "Iv1.cfstumbleFAKE";

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

function githubHoldingRedemption(deviceCodes: readonly Reply[], redemption: Reply) {
  const redeeming = Latch.makeUnsafe();
  const released = Latch.makeUnsafe();
  let issued = 0;

  const fetcher: GitHubFetch = async (url) => {
    if (url.endsWith("/login/device/code")) {
      const reply = deviceCodes[issued] ?? {};
      issued += 1;

      return Response.json(reply);
    }

    Latch.openUnsafe(redeeming);
    await Effect.runPromise(released.await);

    return Response.json(redemption);
  };

  return { fetcher, redeeming, released };
}

interface Tenant {
  readonly workspace: FakeTenantWorkspace;
  github<T>(use: (github: GitHubConnection) => Effect.Effect<T>): Promise<T>;
}

function tenant(name: string, replies: readonly Reply[], configured = true): Tenant {
  return tenantOf(name, githubReplying(replies), configured);
}

function tenantOf(
  name: string,
  fetcher: GitHubFetch,
  configured = true,
  fallbackToken?: string,
): Tenant {
  const clientId = configured ? CLIENT_ID : undefined;
  const workspace = new FakeTenantWorkspace();

  return {
    workspace,
    github: (use) =>
      runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
        Effect.runPromise(
          use(
            new GitHubConnection({
              store: new GitHubConnectionStore(state.storage),
              workspaceName: tenantWorkspaceName(name),
              namespace: workspace.namespace,
              environment: { clientId, fallbackToken, fetcher },
            }),
          ),
        ),
      ),
  };
}

afterEach(async () => {
  await reset();
});

test("shows the verification page and the user code, and never the device code", async () => {
  const subject = tenant("authorization-start", [deviceReply]);

  const started = await subject.github((github) => github.startAuthorization(NOW));

  const status = await subject.github((github) => github.status(NOW));

  expect(started).toEqual({
    ok: true,
    status: {
      state: "awaiting-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
      expiresAt: NOW + 900_000,
    },
    checkedAt: null,
  });
  expect(JSON.stringify(status)).not.toContain("device-code-secret");
});

test("installs the token into the workspace and returns a status without it", async () => {
  const subject = tenant("authorization-completes", [
    deviceReply,
    { access_token: FAKE_TOKEN, token_type: "bearer" },
  ]);

  await subject.github((github) => github.startAuthorization(NOW));

  const completed = await subject.github((github) => github.completeAuthorization(NOW + 1_000));

  expect(completed).toEqual({
    ok: true,
    status: { state: "connected", login: "octocat", source: "device-authorization" },
    checkedAt: NOW + 1_000,
  });
  expect(
    subject.workspace.credentialRequests.filter((sent) => sent.includes(FAKE_TOKEN)),
    "the token reaches the workspace install and nothing else",
  ).toHaveLength(1);
  expect(JSON.stringify(completed)).not.toContain(FAKE_TOKEN);
});

test("redeems one authorization once, so a replayed completion finds nothing", async () => {
  const subject = tenant("authorization-replay", [deviceReply, { access_token: FAKE_TOKEN }]);
  await subject.github((github) => github.startAuthorization(NOW));

  const first = await subject.github((github) => github.completeAuthorization(NOW + 1_000));

  const replayed = await subject.github((github) => github.completeAuthorization(NOW + 2_000));

  expect(first).toMatchObject({ ok: true });
  expect(replayed).toEqual({ ok: false, problem: "no-pending-authorization" });
});

const AWAITING = { state: "awaiting-authorization" };

test.each([
  {
    reply: { error: "authorization_pending" },
    completed: { ok: true, status: AWAITING },
    afterwards: AWAITING,
  },
  {
    reply: { error: "server_error" },
    completed: { ok: false, problem: "provider-unavailable" },
    afterwards: AWAITING,
  },
  {
    reply: { error: "expired_token" },
    completed: { ok: false, problem: "authorization-expired" },
    afterwards: { state: "disconnected" },
  },
  {
    reply: { error: "access_denied" },
    completed: { ok: false, problem: "authorization-denied" },
    afterwards: { state: "disconnected" },
  },
])("settles the authorization as expected when GitHub answers $reply", async (row) => {
  const subject = tenant(`authorization-${row.reply.error}`, [deviceReply, row.reply]);
  await subject.github((github) => github.startAuthorization(NOW));

  const completed = await subject.github((github) => github.completeAuthorization(NOW + 1_000));

  const afterwards = await subject.github((github) => github.status(NOW + 1_000));

  expect(completed).toMatchObject(row.completed);
  expect(afterwards).toMatchObject(row.afterwards);
});

test.each([
  ["denies", { error: "access_denied" }],
  ["expires", { error: "expired_token" }],
  ["authorizes", { access_token: FAKE_TOKEN, token_type: "bearer" }],
])(
  "keeps a newer authorization when an older redemption %s afterwards",
  async (answer, redemption) => {
    const newerDevice = { ...deviceReply, device_code: "newer-code", user_code: "NEWR-CODE" };
    const provider = githubHoldingRedemption([deviceReply, newerDevice], redemption);
    const subject = tenantOf(`authorization-superseded-${answer}`, provider.fetcher);

    const { older, afterwards } = await subject.github((github) =>
      Effect.gen(function* () {
        yield* github.startAuthorization(NOW);

        const startNewerDuringRedemption = Effect.gen(function* () {
          yield* provider.redeeming.await;
          yield* github.startAuthorization(NOW + 2_000);
          yield* provider.released.open;
        });

        const [olderCompletion] = yield* Effect.all(
          [github.completeAuthorization(NOW + 1_000), startNewerDuringRedemption],
          { concurrency: "unbounded" },
        );

        return {
          older: olderCompletion,
          afterwards: yield* github.status(NOW + 3_000),
        };
      }),
    );

    const newerPending = { state: "awaiting-authorization", userCode: "NEWR-CODE" };

    expect(older).toMatchObject({ ok: true, status: newerPending });
    expect(afterwards).toMatchObject(newerPending);
    expect(subject.workspace.credentialRequests.join("")).not.toContain(FAKE_TOKEN);
  },
);

test("drops an authorization the owner never finished, rather than keeping the code", async () => {
  const subject = tenant("authorization-expires", [deviceReply, { access_token: FAKE_TOKEN }]);
  await subject.github((github) => github.startAuthorization(NOW));

  const afterWindow = await subject.github((github) => github.completeAuthorization(NOW + 900_001));

  expect(afterWindow).toEqual({ ok: false, problem: "no-pending-authorization" });
});

test("refuses to start without a configured GitHub OAuth client", async () => {
  const subject = tenant("authorization-unconfigured", [deviceReply], false);

  const started = await subject.github((github) => github.startAuthorization(NOW));

  expect(started).toEqual({ ok: false, problem: "not-configured" });
});

test("a pending authorization does not hide the workspace credential from the repair", async () => {
  const subject = tenantOf(
    "authorization-overlay",
    githubReplying([deviceReply]),
    true,
    FAKE_TOKEN,
  );

  subject.workspace.credentialState = "missing";
  await subject.github((github) => github.startAuthorization(NOW));

  const repaired = await subject.github((github) => github.ensureCredential(NOW + 1));
  const afterwards = await subject.github((github) => github.status(NOW + 2));

  expect(repaired).toMatchObject({ state: "connected", source: "configured-token" });
  expect(afterwards).toMatchObject({ state: "awaiting-authorization" });
  expect(subject.workspace.credentialState).toBe("connected");
});
