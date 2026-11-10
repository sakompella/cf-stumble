import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { HeldWorkspaces } from "../../../src/supervisor/conversations/held-workspaces.js";
import { Generations } from "../../../src/supervisor/generations.js";
import { GitHubConnection, GitHubConnectionStore } from "../../../src/supervisor/projects/index.js";
import { ProvisionFence, WorkspaceReadiness } from "../../../src/supervisor/readiness/index.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import type { HeldHost } from "./held-host.js";

export function withHeldWorkspaces(
  name: string,
  host: HeldHost,
  check: (held: HeldWorkspaces) => Promise<void>,
): Promise<void> {
  const namespace = { getByName: () => host };

  return runInDurableObject(env.SUPERVISOR.getByName(name), async (_instance, state) => {
    const readiness = new WorkspaceReadiness({
      workspaceName: name,
      fence: new ProvisionFence(),
      namespace,
      generations: new Generations(state.storage, FACET_COMPATIBILITY),
      github: new GitHubConnection({
        store: new GitHubConnectionStore(state.storage),
        workspaceName: name,
        namespace: { getByName: () => ({ credential: () => Promise.reject(new Error("none")) }) },
        environment: { clientId: undefined, fallbackToken: undefined, fetcher: fetch },
      }),
      ensureProvisioned: () =>
        Effect.promise(() => host.provision()).pipe(
          Effect.as({ ok: true, project: sampleProjectOne } as const),
        ),
    });

    await check(
      new HeldWorkspaces((selected, remainingMs) => readiness.obtain(selected, remainingMs)),
    );
  });
}
