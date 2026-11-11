import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { Generations } from "../../../src/supervisor/generations.js";
import { GitHubConnection, GitHubConnectionStore } from "../../../src/supervisor/projects/index.js";
import { ProvisionFence, WorkspaceReadiness } from "../../../src/supervisor/readiness/index.js";
import { HARNESS_PROJECT } from "../../../src/selectable-projects.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";

const TOKEN = "ghp_cfstumbleHARNESStokenFAKE0123456789ab";

class HarnessWorkspace extends FakeTenantWorkspace {
  project(): Promise<never> {
    return Promise.reject(new Error("no capability in this test"));
  }
}

function harnessTurn(
  name: string,
  workspace: HarnessWorkspace,
  fallbackToken?: string,
): Promise<void> {
  const namespace = { getByName: () => workspace };

  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    const readiness = new WorkspaceReadiness({
      workspaceName: name,
      fence: new ProvisionFence(),
      namespace,
      generations: new Generations(state.storage, FACET_COMPATIBILITY),
      github: new GitHubConnection({
        store: new GitHubConnectionStore(state.storage),
        workspaceName: name,
        namespace,
        environment: { clientId: undefined, fallbackToken, fetcher: fetch },
      }),
      ensureProvisioned: () => Effect.die(new Error("the harness is not a repository project")),
    });

    return Effect.runPromise(
      Effect.scoped(Effect.asVoid(readiness.obtain(HARNESS_PROJECT, 1_000))),
    );
  });
}

afterEach(async () => {
  await reset();
});

test("a harness turn installs the configured token into a workspace without a credential, once", async () => {
  const workspace = new HarnessWorkspace();

  await harnessTurn("harness-credential-installed", workspace, TOKEN);
  const requestsAfterFirstTurn = workspace.credentialRequests.length;
  await harnessTurn("harness-credential-installed", workspace, TOKEN);

  expect(workspace.credentialState).toBe("connected");
  expect(workspace.stdins.map(([, stdin]) => stdin)).toEqual([`${TOKEN}\n`]);
  expect(workspace.credentialRequests).toHaveLength(requestsAfterFirstTurn);
});

test("a harness turn without a configured token runs no credential command", async () => {
  const workspace = new HarnessWorkspace();

  await harnessTurn("harness-credential-unconfigured", workspace);

  expect(workspace.credentialRequests).toEqual([]);
  expect(workspace.credentialState).toBe("missing");
});
