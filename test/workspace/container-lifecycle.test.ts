import { afterEach, expect, test, vi } from "vitest";
import { recordWorkspaceContainerClosed } from "../../src/workspace/backend-sync-ignore.js";
import { capturedEvents, named } from "../log-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("records structured stopped and exited events with safe reason and exit-code fields", async () => {
  const events = capturedEvents();
  await recordWorkspaceContainerClosed({
    status: () =>
      Promise.resolve({
        running: false,
        exit: {
          reason: "Container exited with unexpected exit code: 1",
          exitCode: 1,
          signal: "SIGKILL",
        },
      }),
  });

  expect(named(events(), "workspace.container.stopped").at(0)).toMatchObject({
    level: "warn",
    outcome: "stopped",
    reasonCode: "unexpected-exit-code",
    exitCode: 1,
    signal: "SIGKILL",
    running: false,
  });
  expect(named(events(), "workspace.container.exited").at(0)).toMatchObject({
    level: "warn",
    outcome: "exited",
    reasonCode: "unexpected-exit-code",
    exitCode: 1,
    signal: "SIGKILL",
    expected: false,
  });
  expect(JSON.stringify(events())).not.toContain("unexpected exit code: 1");
});
