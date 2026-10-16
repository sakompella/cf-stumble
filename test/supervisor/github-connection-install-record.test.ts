/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { GitHubConnection, GitHubConnectionStore } from "../../src/supervisor/projects/index.js";
import { FakeTenantWorkspace } from "./projects/fake-tenant-workspace.js";

const NOW = 1_700_000_000_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test.each(["unavailable", "tooling-missing"] as const)(
  "a device authorization whose install ends %s replaces the connected record",
  async (failure) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runInDurableObject(
      env.SUPERVISOR.getByName(`install-record-${failure}`),
      async (_instance, state) => {
        const workspace = new FakeTenantWorkspace();
        workspace.credentialState = "connected";

        const replies = [
          {
            device_code: "synthetic-device",
            user_code: "TEST-CODE",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          },
          { access_token: "ghp_cfstumbleFAKEtokenFAKEtoken0123456789", token_type: "bearer" },
        ];

        const github = new GitHubConnection({
          store: new GitHubConnectionStore(state.storage),
          workspaceName: "install-record",
          namespace: workspace.namespace,
          environment: {
            clientId: "synthetic-client",
            fallbackToken: undefined,
            fetcher: () => Promise.resolve(Response.json(replies.shift())),
          },
        });

        await Effect.runPromise(github.status(NOW));
        expect(github.lastKnown(NOW).github?.state).toBe("connected");
        const owner = { identity: "synthetic-owner", audience: "synthetic-audience" };
        await Effect.runPromise(github.startAuthorization(owner, NOW + 1_000));

        if (failure === "unavailable") workspace.unavailable = true;
        else workspace.credentialState = "tooling-missing";
        const result = await Effect.runPromise(github.completeAuthorization(owner, NOW + 2_000));

        if (!result.ok) throw new Error("authorization result must carry install status");
        expect(result.status.state).toBe(
          failure === "unavailable" ? "reconnect-required" : "tooling-missing",
        );
        expect(github.lastKnown(NOW + 3_000)).toEqual({
          github: result.status,
          checkedAt: NOW + 2_000,
        });
      },
    );
  },
);
