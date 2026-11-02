import type { ExecSyncResult } from "@cloudflare/computer";
import { expect, test } from "vitest";
import { commandOutput } from "../../src/workspace/computer-operations.js";
import { WorkspaceSyncIncomplete } from "../../src/workspace/executor.js";

const ran = { stdout: "out", stderr: "", exitCode: 0 } as const;

const complete: ExecSyncResult = { status: "complete", applied: 3, skipped: [] };

const pending: ExecSyncResult = {
  status: "pending",
  applied: 0,
  skipped: [],
  error: "pull failed",
};

const skipped: ExecSyncResult = {
  status: "complete",
  applied: 2,
  skipped: [
    { path: "/workspace/projects/p", mountRoot: "/workspace", op: "delete", reason: "read-only" },
  ],
};

test("a completed sync gives the command's output under either policy", () => {
  for (const policy of ["require-complete", "not-required"] as const) {
    expect(commandOutput({ ...ran, sync: complete }, policy)).toEqual(ran);
  }
});

test.each([
  ["pending", pending],
  ["complete with skipped entries", skipped],
] as const)("a %s sync fails a command that needs a durable result", (_case, sync) => {
  expect(() => commandOutput({ ...ran, sync }, "require-complete")).toThrow(
    WorkspaceSyncIncomplete,
  );
});

test("a command that does not need a durable result ignores a pending sync", () => {
  expect(commandOutput({ ...ran, sync: pending }, "not-required")).toEqual(ran);
});
