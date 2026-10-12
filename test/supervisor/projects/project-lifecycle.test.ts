/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";
import type { ProjectConnections } from "../../../src/supervisor/projects/index.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import { tenantConnections } from "./tenant-connections.js";

/**
 * Overlapping lifecycle operations on one project id. The fake workspace holds a chosen command
 * open, so each test decides the interleaving instead of hoping a scheduler produces it. These
 * tests show the order in which the Supervisor asks the Workspace Host for work; they cannot show
 * what Computer's filesystem does with overlapping commands.
 */

const NOW = 1_700_000_000_000;

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

const REPOSITORY = "https://github.com/sample/repo-1";

const PROJECT_ID = "sample-repo-1";

const REMOVAL = "rm -rf --";

const CLONE = "git clone";

const threadReleased = () => ({ ok: true }) as const;

/** One `ProjectConnections`, as one Supervisor instance holds it, over the fake workspace. */
function withConnections<T>(
  name: string,
  workspace: FakeTenantWorkspace,
  use: (connections: ProjectConnections) => Promise<T>,
): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
    use(
      tenantConnections(state.storage, name, workspace, {
        clientId: undefined,
        fallbackToken: FAKE_TOKEN,
        // No size metadata: the preflight is skipped, which keeps these tests about ordering.
        fetcher: () => Promise.resolve(Response.json({})),
      }).connections,
    ),
  );
}

/**
 * Let every operation that is not waiting on a held command run as far as it can. The fake
 * answers through promises and the RPC timers, so a few macrotask turns reach a steady state.
 */
async function letOtherWorkRun(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function isConnected(connections: ProjectConnections): boolean {
  return connections.catalog().some((project) => project.id === PROJECT_ID);
}

function indexOfLast(commands: readonly string[], fragment: string): number {
  return commands.findLastIndex((command) => command.includes(fragment));
}

afterEach(async () => {
  await reset();
});

test("a reconnect waits until the earlier disconnect has removed the clone", async () => {
  const workspace = new FakeTenantWorkspace();

  await withConnections("reconnect-during-removal", workspace, async (connections) => {
    await Effect.runPromise(connections.connect(REPOSITORY, undefined, NOW));
    const removal = workspace.holdNext(REMOVAL);
    const disconnecting = Effect.runPromise(connections.disconnect(PROJECT_ID, threadReleased));
    await removal.reached;
    const clonesBeforeReconnect = indexOfLast(workspace.commands, CLONE);

    const reconnecting = Effect.runPromise(connections.connect(REPOSITORY, undefined, NOW + 1));
    await letOtherWorkRun();

    expect(
      indexOfLast(workspace.commands, CLONE),
      "no clone may start while the same directory is being removed",
    ).toBe(clonesBeforeReconnect);

    removal.release(0);

    await expect(disconnecting).resolves.toEqual({
      ok: true,
      projectId: PROJECT_ID,
      workspace: "removed",
    });
    await expect(reconnecting).resolves.toMatchObject({ ok: true, alreadyConnected: false });
    expect(indexOfLast(workspace.commands, CLONE)).toBeGreaterThan(
      indexOfLast(workspace.commands, REMOVAL),
    );
    expect(isConnected(connections)).toBe(true);
  });
});

test("a failed connection leaves the row that an overlapping connection provisioned", async () => {
  const workspace = new FakeTenantWorkspace();

  await withConnections("overlapping-connections", workspace, async (connections) => {
    const firstClone = workspace.holdNext(CLONE);
    const first = Effect.runPromise(connections.connect(REPOSITORY, undefined, NOW));
    await firstClone.reached;

    const second = Effect.runPromise(connections.connect(REPOSITORY, undefined, NOW + 1));
    await letOtherWorkRun();
    firstClone.release(128);

    await expect(first).resolves.toMatchObject({
      ok: false,
      problem: { code: "provisioning-failed" },
    });
    await expect(second).resolves.toMatchObject({ ok: true, project: { id: PROJECT_ID } });
    expect(isConnected(connections), "a connection reported as successful stays connected").toBe(
      true,
    );
  });
});

test("a disconnect during a connection's clone removes the clone after it lands", async () => {
  const workspace = new FakeTenantWorkspace();

  await withConnections("disconnect-during-clone", workspace, async (connections) => {
    const clone = workspace.holdNext(CLONE);
    const connecting = Effect.runPromise(connections.connect(REPOSITORY, undefined, NOW));
    await clone.reached;

    const disconnecting = Effect.runPromise(connections.disconnect(PROJECT_ID, threadReleased));
    await letOtherWorkRun();

    expect(
      indexOfLast(workspace.commands, REMOVAL),
      "removal may not overlap the clone that is creating the same directory",
    ).toBe(-1);

    clone.release(0);

    await expect(connecting).resolves.toMatchObject({ ok: true });
    await expect(disconnecting).resolves.toMatchObject({ ok: true, workspace: "removed" });
    expect(indexOfLast(workspace.commands, REMOVAL)).toBeGreaterThan(
      indexOfLast(workspace.commands, CLONE),
    );
    expect(isConnected(connections)).toBe(false);
  });
});

test("a disconnect waits for the thread check until an earlier connection has settled", async () => {
  const workspace = new FakeTenantWorkspace();

  await withConnections("disconnect-thread-order", workspace, async (connections) => {
    const clone = workspace.holdNext(CLONE);
    const connecting = Effect.runPromise(connections.connect(REPOSITORY, undefined, NOW));
    await clone.reached;
    let threadChecked = false;

    const disconnecting = Effect.runPromise(
      connections.disconnect(PROJECT_ID, () => {
        threadChecked = true;

        return { ok: false, problem: { code: "turn-active", deadlineAt: NOW } };
      }),
    );

    await letOtherWorkRun();

    expect(threadChecked, "the thread is released inside the same ordered operation").toBe(false);

    clone.release(0);
    await connecting;

    await expect(disconnecting).resolves.toEqual({
      ok: false,
      problem: { code: "turn-active", deadlineAt: NOW },
    });
    expect(isConnected(connections)).toBe(true);
  });
});

test("provisioning on use waits for a failing connection and then finds no project", async () => {
  const workspace = new FakeTenantWorkspace();

  await withConnections("use-during-failed-connection", workspace, async (connections) => {
    const clone = workspace.holdNext(CLONE);
    const connecting = Effect.runPromise(connections.connect(REPOSITORY, undefined, NOW));
    await clone.reached;

    const clonesDuringConnection = workspace.commands.filter((command) =>
      command.includes(CLONE),
    ).length;

    const used = Effect.runPromise(connections.ensureProvisioned(PROJECT_ID));
    await letOtherWorkRun();
    clone.release(128);

    await expect(connecting).resolves.toMatchObject({ ok: false });
    await expect(used).resolves.toEqual({ ok: false, problem: { code: "unknown-project-id" } });
    expect(workspace.commands.filter((command) => command.includes(CLONE))).toHaveLength(
      clonesDuringConnection,
    );
  });
});
