import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceHost } from "../../src/workspace/host.js";
import { PROJECT_TURN_LEASE_MS } from "../../src/turn-budget.js";
import { WORKSPACE_ROOT } from "../../src/workspace-layout.js";
import { WORKSPACE_IDLE_STOP_MS } from "../../src/workspace/idle-stop.js";
import { sampleProjectOne } from "../project-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

class FakeContainer {
  running = true;
  readonly destroyed: unknown[] = [];
  starts = 0;
  destroyGate: Promise<void> | undefined;

  start(): void {
    this.starts += 1;

    throw new Error("the fake container does not launch");
  }

  destroy(reason: string): Promise<void> {
    this.destroyed.push(reason);

    if (reason === "idle") this.running = false;

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

test("a Host RPC arms the idle alarm one limit after it ends", async () => {
  const armed = await withHost("host-seam-rpc", async (host, state) => {
    const before = Date.now();
    await host.build({ kind: "not-a-build" });

    return { alarm: await state.storage.getAlarm(), before };
  });

  expect(armed.alarm).not.toBeNull();
  expect((armed.alarm ?? 0) - armed.before).toBeGreaterThanOrEqual(WORKSPACE_IDLE_STOP_MS);
});

test("each tracked RPC arms the idle alarm when it ends", async () => {
  const requests = {
    build: (host: WorkspaceHost) => host.build({ kind: "not-a-build" }),
    provision: (host: WorkspaceHost) => host.provision({ kind: "not-a-step" }),
    removeProject: (host: WorkspaceHost) => host.removeProject({ kind: "not-a-removal" }),
    credential: (host: WorkspaceHost) => host.credential({ kind: "not-a-credential" }),
    ensureManagedInstructions: (host: WorkspaceHost) => host.ensureManagedInstructions(),
  };

  for (const [rpc, call] of Object.entries(requests)) {
    const alarm = await withHost(`host-seam-${rpc}`, async (host, state) => {
      await call(host);

      return state.storage.getAlarm();
    });

    expect(alarm, `${rpc} arms the alarm`).not.toBeNull();
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
    const project = host.project({ remainingMs: PROJECT_TURN_LEASE_MS });
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
    await host.build({ kind: "not-a-build" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + WORKSPACE_IDLE_STOP_MS + 1);
    await host.alarm();

    return container.destroyed;
  });

  expect(destroyed).toEqual(["idle"]);
});

test("a call on the project capability counts as activity", async () => {
  const calledAtMs = PROJECT_TURN_LEASE_MS + 120_000;

  const destroyed = await withHost("host-seam-touch", async (host, _state, container) => {
    const start = Date.now();
    const project = host.project();
    vi.spyOn(Date, "now").mockReturnValue(start + calledAtMs);
    await project.lstat("/");
    vi.spyOn(Date, "now").mockReturnValue(start + WORKSPACE_IDLE_STOP_MS + calledAtMs - 1);
    await host.alarm();

    return container.destroyed;
  });

  expect(destroyed, "the alarm finds the limit not yet passed since the call").toEqual([]);
});

test("a reset that lost the alarm arms a new one", async () => {
  const alarm = await withHost("host-seam-reset", async (host, state) => {
    await host.build({ kind: "not-a-build" });
    await state.storage.deleteAlarm();
    await host.reset().catch(() => {});

    return state.storage.getAlarm();
  });

  expect(alarm).not.toBeNull();
});

async function seedWorkspaceRoot(state: DurableObjectState): Promise<void> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the Host makes the same cast; Computer accepts the Durable Object SQLite API its generic cursor declaration narrows.
  const storage = state.storage as DurableObjectStorageLike;

  const workspace = new Workspace({
    storage,
    sessionId: state.id.toString(),
    backends: [],
  });

  await workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
}

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
    await host.build({ kind: "not-a-build" });
    await seedWorkspaceRoot(state);

    const project = host.project();

    vi.spyOn(Date, "now").mockReturnValue(
      Date.now() + PROJECT_TURN_LEASE_MS + WORKSPACE_IDLE_STOP_MS + 1_000,
    );
    const alarm = host.alarm();
    await tick();
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

test("a reset refuses while a file change or credential install is in flight and leaves the store alone", async () => {
  const changes = {
    provision: (host: WorkspaceHost) =>
      host.provision({
        kind: "provision-project",
        projectId: sampleProjectOne.id,
        repositoryUrl: sampleProjectOne.repositoryUrl,
        step: "clone",
      }),
    credentialInstall: (host: WorkspaceHost) =>
      host.credential({ kind: "github-credential", step: "install", token: FAKE_TOKEN }),
    ensureManagedInstructions: (host: WorkspaceHost) => host.ensureManagedInstructions(),
  };

  for (const [name, change] of Object.entries(changes)) {
    const held = { release: (): void => {} };

    const stalled = new Promise<void>((resolve) => {
      held.release = resolve;
    });

    const seen = await withHost(`host-reset-busy-${name}`, async (host, state) => {
      // SAFETY: each member the change reaches is a function that waits; nothing reads the rest.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const waiting = new Proxy({}, { get: () => () => stalled }) as never;
      vi.spyOn(Workspace.prototype, "fs", "get").mockReturnValue(waiting);
      vi.spyOn(Workspace.prototype, "runtime", "get").mockReturnValue(waiting);
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
    build: await host.build({ kind: "not-a-build" }),
    provision: await host.provision({ kind: "not-a-step" }),
    removeProject: await host.removeProject({ kind: "not-a-removal" }),
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
      afterwards: await host.build({ kind: "not-a-build" }),
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
