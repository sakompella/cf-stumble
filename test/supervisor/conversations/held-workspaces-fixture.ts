import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { HeldWorkspaces } from "../../../src/supervisor/conversations/held-workspaces.js";
import { generationsOf, served } from "../generations/generation-ports.js";
import { GitHubConnection, GitHubConnectionStore } from "../../../src/supervisor/projects/index.js";
import {
  provisionOnUse,
  ProvisionFence,
  WorkspaceReadiness,
} from "../../../src/supervisor/readiness/index.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import type { HeldHost } from "./held-host.js";

export function withHeldWorkspaces(
  name: string,
  host: HeldHost,
  check: (held: HeldWorkspaces) => Promise<void>,
  options: Readonly<{ activeGeneration?: boolean }> = {},
): Promise<void> {
  const namespace = { getByName: () => host };

  return runInDurableObject(env.SUPERVISOR.getByName(name), async (_instance, state) => {
    const generations = generationsOf(state.storage);

    if (options.activeGeneration === true) served(generations, "c");

    const fence = new ProvisionFence();

    const github = new GitHubConnection({
      store: new GitHubConnectionStore(state.storage),
      workspaceName: name,
      namespace: {
        getByName: () => ({
          installCredential: () => Promise.reject(new Error("none")),
          credentialStatus: () => Promise.reject(new Error("none")),
          checkRepositoryAccess: () => Promise.reject(new Error("none")),
        }),
      },
      environment: { clientId: undefined, fallbackToken: undefined, fetcher: fetch },
    });

    const readiness = new WorkspaceReadiness({
      workspaceName: name,
      fence,
      namespace,
      generations,
      github,
      ensureProvisioned: (projectId) =>
        provisionOnUse(
          { workspaceName: name, fence, namespace, github, catalog: () => [sampleProjectOne] },
          projectId,
        ),
    });

    await check(
      new HeldWorkspaces((selected, remainingMs) => readiness.obtain(selected, remainingMs)),
    );
  });
}
