import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceHost } from "../../src/workspace/host.js";
import {
  REFUSED_BUILD,
  REFUSED_CREDENTIAL,
  REFUSED_PROVISION,
  REFUSED_REMOVAL,
  restoreWorkspaceMembers,
  seedWorkspaceRoot,
  stubWorkspaceMember,
} from "./host-fixtures.js";
import { WORKSPACE_IDLE_STOP_MS } from "../../src/workspace/idle-stop.js";
import { sampleProjectOne } from "../project-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  restoreWorkspaceMembers();
});

class FakeContainer {
  running = true;
  readonly images = { app: "workspace-image" };
  readonly destroyed: unknown[] = [];
  starts = 0;
  destroyGate: Promise<void> | undefined;

  start(): void {
    this.starts += 1;

    throw new Error("the fake container does not launch");
  }

  destroy(reason?: string): Promise<void> {
    this.destroyed.push(reason);

    if (reason !== undefined) this.running = false;

    return this.destroyGate ?? Promise.resolve();
  }
}

function withHost<T>(
  name: string,
  run: (host: WorkspaceHost, state: DurableObjectState, container: FakeContainer) => Promise<T>,
): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    const container = new FakeContainer();

    Object.defineProperty(state, "container", { value: container, configurable: true });

    return run(new WorkspaceHost(state, {}), state, container);
  });
}

test("each tracked RPC arms the idle alarm one limit after it ends", async () => {
  const requests = {
    build: (host: WorkspaceHost) => host.build(REFUSED_BUILD),
    provision: (host: WorkspaceHost) => host.provision(REFUSED_PROVISION),
    removeProject: (host: WorkspaceHost) => host.removeProject(REFUSED_REMOVAL),
    credential: (host: WorkspaceHost) => host.credential(REFUSED_CREDENTIAL),
    ensureManagedInstructions: (host: WorkspaceHost) => host.ensureManagedInstructions(),
  };

  for (const [rpc, call] of Object.entries(requests)) {
    const alarm = await withHost(`host-seam-${rpc}`, async (host, state) => {
      const before = Date.now();
      await call(host);

      return { alarm: await state.storage.getAlarm(), before };
    });

    expect(alarm.alarm, `${rpc} arms the alarm`).not.toBeNull();
    expect(
      (alarm.alarm ?? 0) - alarm.before,
      `${rpc} arms it one idle limit after it ends`,
    ).toBeGreaterThanOrEqual(WORKSPACE_IDLE_STOP_MS);
  }
});

test("a project capability leases the workspace until the end of its turn", async () => {
  const leaseMs = 60_000;

  const result = await withHost("host-seam-lease", async (host, state) => {
    const before = Date.now();
    host.project({ remainingMs: leaseMs });

    return { alarm: await state.storage.getAlarm(), before };
  });

  const armedAfter = (result.alarm ?? 0) - result.before;
  expect(armedAfter).toBeGreaterThanOrEqual(leaseMs + WORKSPACE_IDLE_STOP_MS);
  expect(armedAfter, "the lease is the turn's budget, not the longer default").toBeLessThan(
    leaseMs + WORKSPACE_IDLE_STOP_MS + 5_000,
  );
});

test("an ended project capability holds the workspace one idle limit from its end", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  const result = await withHost("host-seam-lease-end", async (host, state, container) => {
    const project = host.project({ remainingMs: 9 * 60_000 });
    const endedAt = Date.now();
    await project.endTurn();
    const alarm = (await state.storage.getAlarm()) ?? 0;
    vi.spyOn(Date, "now").mockReturnValue(alarm);
    await host.alarm();

    return { armedAfter: alarm - endedAt, destroyed: container.destroyed };
  });

  expect(result.armedAfter).toBeLessThan(WORKSPACE_IDLE_STOP_MS + 5_000);
  expect(result.destroyed).toEqual(["idle"]);
});

test("a past-due alarm closes the Workspace and destroys the container for being idle", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  const destroyed = await withHost("host-seam-stop", async (host, _state, container) => {
    await host.build(REFUSED_BUILD);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + WORKSPACE_IDLE_STOP_MS + 1);
    await host.alarm();

    return container.destroyed;
  });

  expect(destroyed).toEqual(["idle"]);
});

test("a backend change while a project lease is held is refused and leaves the container running", async () => {
  const result = await withHost("host-seam-backend-lease", async (host, _state, container) => {
    host.project({ remainingMs: 60_000 });

    return { change: await host.setBackend("cloudflare"), destroyed: container.destroyed };
  });

  expect(result.change).toEqual({ ok: false, problem: { code: "workspace-busy" } });
  expect(result.destroyed).toEqual([]);
});

test.each([
  [true, 1],
  [false, 0],
] as const)(
  "a reset with the container running=%s deletes the store, destroys %i containers and starts none",
  async (running, destroyedCount) => {
    const seen = await withHost(
      `host-seam-reset-${String(running)}`,
      async (host, _state, container) => {
        container.running = running;
        await host.build(REFUSED_BUILD);
        const answer = await host.reset();

        return {
          answer,
          starts: container.starts,
          running: container.running,
          destroyed: container.destroyed.length,
        };
      },
    );

    expect(seen).toEqual({
      answer: { ok: true, reset: "workspace" },
      starts: 0,
      running: false,
      destroyed: destroyedCount,
    });
  },
);

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

test("an exec started while the idle stop destroys the container waits for it", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  const seen = await withHost("host-seam-exec-wait", async (host, state, container) => {
    const open = { release: (): void => {} };

    container.destroyGate = new Promise<void>((resolve) => {
      open.release = resolve;
    });
    await host.build(REFUSED_BUILD);
    await seedWorkspaceRoot(state);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + WORKSPACE_IDLE_STOP_MS + 1_000);
    const alarm = host.alarm();
    await tick();
    const project = host.project({ remainingMs: 60_000 });
    const started = await project.startExec({ command: "true", timeoutMs: 1_000 });
    await tick();
    const whileDestroying = container.starts;
    open.release();
    await alarm;
    await tick();

    return { whileDestroying, afterwards: container.starts, started };
  });

  expect(seen.started.ok, "the exec is accepted").toBe(true);
  expect(seen.whileDestroying, "it does not reach the container during the destroy").toBe(0);
  expect(seen.afterwards, "it reaches the container once the destroy settled").toBeGreaterThan(0);
});

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

test("a reset refuses while a file change or credential request is in flight and leaves the store alone", async () => {
  const changes = {
    provision: (host: WorkspaceHost) =>
      host.provision({
        kind: "provision-project",
        projectId: sampleProjectOne.id,
        repositoryUrl: sampleProjectOne.repositoryUrl,
      }),
    credentialInstall: (host: WorkspaceHost) =>
      host.credential({ kind: "github-credential", step: "install", token: FAKE_TOKEN }),
    credentialStatus: (host: WorkspaceHost) =>
      host.credential({ kind: "github-credential", step: "status" }),
    ensureManagedInstructions: (host: WorkspaceHost) => host.ensureManagedInstructions(),
  };

  for (const [name, change] of Object.entries(changes)) {
    const held = { release: (): void => {} };

    const stalled = new Promise<void>((resolve) => {
      held.release = resolve;
    });

    const seen = await withHost(`host-reset-busy-${name}`, async (host, state) => {
      stubWorkspaceMember("fs", {
        lstat: () => stalled,
        readFile: () => stalled,
        writeFile: () => stalled,
      });
      stubWorkspaceMember("runtime", { exec: () => stalled });
      await state.storage.put("durable-row", "kept");

      const inFlight = change(host);

      await tick();
      const refused = await host.reset();
      const row = await state.storage.get("durable-row");
      held.release();
      await inFlight;

      return { refused, row };
    });

    expect(seen.refused, name).toEqual({ ok: false, problem: { code: "workspace-busy" } });
    expect(seen.row, `the reset refused during ${name} deleted nothing`).toBe("kept");
    vi.restoreAllMocks();
    restoreWorkspaceMembers();
  }
});

function capabilityAnswer(host: WorkspaceHost): "handed out" | "refused" {
  try {
    host.project({ remainingMs: 60_000 });

    return "handed out";
  } catch {
    return "refused";
  }
}

async function changesDuringReset(host: WorkspaceHost) {
  return {
    build: await host.build(REFUSED_BUILD),
    provision: await host.provision(REFUSED_PROVISION),
    removeProject: await host.removeProject(REFUSED_REMOVAL),
    ensureManagedInstructions: await host.ensureManagedInstructions(),
    credentialInstall: await host.credential({
      kind: "github-credential",
      step: "install",
      token: FAKE_TOKEN,
    }),
    credentialStatus: await host.credential({ kind: "github-credential", step: "status" }),
    credentialRepositoryCheck: await host.credential({
      kind: "github-credential",
      step: "verify-repository",
      repositoryUrl: sampleProjectOne.repositoryUrl,
    }),
    reset: await host.reset(),
    capability: capabilityAnswer(host),
  };
}

test("while a reset runs, file changes, credential requests, project capabilities, and a second reset refuse", async () => {
  const seen = await withHost("host-reset-exclusion", async (host, state, container) => {
    const held = { release: (): void => {} };

    const deleting = new Promise<void>((resolve) => {
      held.release = resolve;
    });

    const deleteAll = vi.spyOn(state.storage, "deleteAll").mockReturnValue(deleting);
    const resetting = host.reset();

    await vi.waitFor(() => {
      expect(deleteAll).toHaveBeenCalledOnce();
    });

    const during = await changesDuringReset(host);
    const startsDuring = container.starts;

    held.release();
    await resetting.catch(() => {});

    return {
      during,
      deleteCalls: deleteAll.mock.calls.length,
      startsDuring,
      afterwards: await host.build(REFUSED_BUILD),
    };
  });

  const changeBusy = { ok: false, error: { code: "workspace-busy" } };

  const credentialRefused = {
    ok: false,
    error: { code: "workspace-unavailable", detail: "the workspace is resetting" },
  };

  expect(seen.during).toEqual({
    build: changeBusy,
    provision: changeBusy,
    removeProject: changeBusy,
    ensureManagedInstructions: changeBusy,
    credentialInstall: credentialRefused,
    credentialStatus: credentialRefused,
    credentialRepositoryCheck: credentialRefused,
    reset: { ok: false, problem: { code: "workspace-busy" } },
    capability: "refused",
  });
  expect(seen.deleteCalls, "the second reset deleted nothing").toBe(1);
  expect(seen.startsDuring, "no refused request reached the container").toBe(0);
  expect(seen.afterwards, "the exclusion ends with the reset").toEqual({
    ok: false,
    error: { code: "invalid-request" },
  });
});
