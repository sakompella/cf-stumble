import type { ExecSyncResult } from "@cloudflare/computer";
import { expect, test } from "vitest";
import { commandOutput } from "../../src/workspace/computer-operations.js";
import { WorkspaceSyncIncomplete } from "../../src/workspace/operations.js";

const ran = { stdout: "out", stderr: "", exitCode: 0 } as const;

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

test.each([
  ["pending", pending],
  ["complete with skipped entries", skipped],
] as const)("a %s sync fails a command that needs a durable result", (_case, sync) => {
  expect(() => commandOutput({ ...ran, sync }, "require-complete")).toThrow(
    WorkspaceSyncIncomplete,
  );
});
