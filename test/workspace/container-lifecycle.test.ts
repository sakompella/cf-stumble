import { afterEach, expect, test, vi } from "vitest";
import {
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
