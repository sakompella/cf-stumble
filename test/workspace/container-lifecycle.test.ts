import { afterEach, expect, test, vi } from "vitest";
import {
  observeBackendClose,
  readContainerStatus,
  type BackendCloseTrigger,
  recordWorkspaceBackendClosed,
  type WorkspaceContainerStatus,
} from "../../src/workspace/backend-sync-ignore.js";
import { capturedEvents, named } from "../log-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function closeWith(
  status: () => Promise<WorkspaceContainerStatus>,
  trigger: BackendCloseTrigger = "transport-closed",
): Promise<void> {
  recordWorkspaceBackendClosed(trigger, await readContainerStatus({ status }));
}

test("a transport close after an observed exit is one event with the exit fields and no text", async () => {
  const events = capturedEvents();
  await closeWith(() =>
    Promise.resolve({
      running: false,
      exit: {
        reason: "Container exited with unexpected exit code: 1",
        exitCode: 1,
        signal: "SIGKILL",
      },
    }),
  );

  expect(events()).toEqual([
    expect.objectContaining({
      event: "workspace.backend.closed",
      level: "warn",
      trigger: "transport-closed",
      running: false,
      reasonCode: "unexpected-exit-code",
      exitCode: 1,
      signal: "SIGKILL",
      statusReadOutcome: "ok",
    }),
  ]);
  expect(JSON.stringify(events())).not.toContain("unexpected exit code: 1");
});

test("a transport close while the container still runs claims no stop or exit", async () => {
  const events = capturedEvents();
  await closeWith(() => Promise.resolve({ running: true, exit: null }));

  expect(events().map((entry) => entry.event)).toEqual(["workspace.backend.closed"]);
  expect(named(events(), "workspace.backend.closed").at(0)).toMatchObject({
    running: true,
    exitCode: null,
    signal: null,
    statusReadOutcome: "ok",
  });

  for (const claim of ["workspace.container.stopped", "workspace.container.exited"]) {
    expect(named(events(), claim)).toEqual([]);
  }
});

test("a failed status read leaves running unknown instead of guessing false", async () => {
  const events = capturedEvents();
  await closeWith(() => Promise.reject(new Error("status rpc failed")));

  expect(events()).toEqual([
    expect.objectContaining({
      event: "workspace.backend.closed",
      level: "warn",
      running: null,
      reasonCode: "status-unavailable",
      statusReadOutcome: "failed",
    }),
  ]);
});

test("a connect failure is logged as such, not as a transport close", async () => {
  const events = capturedEvents();
  await closeWith(() => Promise.resolve({ running: false, exit: null }), "connect-failed");

  expect(events().map((entry) => entry.event)).toEqual(["workspace.backend.closed"]);
  expect(named(events(), "workspace.backend.closed").at(0)).toMatchObject({
    trigger: "connect-failed",
    running: false,
  });
});

/** A container whose status answers differently on each call, so a second read would show. */
function changingContainer(answers: readonly WorkspaceContainerStatus[]) {
  const reads: number[] = [];

  return {
    reads,
    status: () => {
      reads.push(reads.length);

      return Promise.resolve(
        answers[Math.min(reads.length - 1, answers.length - 1)] ?? answers[0]!,
      );
    },
  };
}

test("a close reads the status once, and the generation decision and the log share that read", async () => {
  const events = capturedEvents();
  let replaced = 0;

  const container = changingContainer([
    { running: false, exit: null },
    { running: true, exit: null },
  ]);

  await observeBackendClose(container, "transport-closed", () => {
    replaced += 1;
  });

  expect(container.reads).toHaveLength(1);
  expect(replaced).toBe(1);
  expect(named(events(), "workspace.backend.closed")).toEqual([
    expect.objectContaining({ running: false }),
  ]);
});

test("a close that finds the container running bumps no generation", async () => {
  capturedEvents();
  let replaced = 0;

  await observeBackendClose(
    changingContainer([{ running: true, exit: null }]),
    "transport-closed",
    () => {
      replaced += 1;
    },
  );

  expect(replaced).toBe(0);
});

test("a failed status read bumps no generation and is logged as unknown", async () => {
  const events = capturedEvents();
  let replaced = 0;

  await observeBackendClose(
    { status: () => Promise.reject(new Error("status rpc failed")) },
    "connect-failed",
    () => {
      replaced += 1;
    },
  );

  expect(replaced).toBe(0);
  expect(named(events(), "workspace.backend.closed")).toEqual([
    expect.objectContaining({ running: null, statusReadOutcome: "failed" }),
  ]);
});
