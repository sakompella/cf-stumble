import type { ExecSyncResult } from "@cloudflare/computer";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { commandOutput } from "../../src/workspace/computer-operations.js";
import { WorkspaceSyncIncomplete, type CommandOutput } from "../../src/workspace/operations.js";

const skipped = gs.arrays(
  gs.record({
    path: gs.text({ minSize: 1, maxSize: 12 }),
    mountRoot: gs.text({ minSize: 1, maxSize: 12 }),
    op: gs.sampledFrom(["write", "delete"] as const),
    reason: gs.just("read-only" as const),
  }),
  { maxSize: 3 },
);

const applied = gs.integers({ minValue: 0, maxValue: 50 });

const syncResult = gs.oneOf<ExecSyncResult>(
  gs.record({ status: gs.just("complete" as const), applied, skipped }),
  gs.record({ status: gs.just("pending" as const), applied, skipped }),
);

const ran = gs.record({
  stdout: gs.text({ maxSize: 20 }),
  stderr: gs.text({ maxSize: 20 }),
  exitCode: gs.integers({ minValue: -300, maxValue: 300 }),
});

const policy = gs.sampledFrom(["require-complete", "not-required"] as const);

function isDurable(sync: ExecSyncResult): boolean {
  return sync.status === "complete" && sync.skipped.length === 0;
}

function refusal(attempt: () => CommandOutput): string | undefined {
  try {
    attempt();
  } catch (error) {
    return error instanceof WorkspaceSyncIncomplete ? error.message : undefined;
  }

  return undefined;
}

test("a command's output is given back unchanged unless its policy demands a durable sync that was not", () => {
  hegel.test((tc) => {
    const output = tc.draw(ran);
    const sync = tc.draw(syncResult);
    const syncPolicy = tc.draw(policy);
    const refused = syncPolicy === "require-complete" && !isDurable(sync);

    if (refused) {
      expect(() => commandOutput({ ...output, sync }, syncPolicy)).toThrow(WorkspaceSyncIncomplete);
    } else {
      expect(commandOutput({ ...output, sync }, syncPolicy)).toStrictEqual(output);
    }
  });
});

test("a refused sync says how the sync ended, how the command exited and how much was skipped", () => {
  hegel.test((tc) => {
    const output = tc.draw(ran);
    const sync = tc.draw(syncResult);
    tc.assume(!isDurable(sync));

    const message = refusal(() => commandOutput({ ...output, sync }, "require-complete"));

    expect(message).toBeDefined();
    expect(message ?? "").toContain(sync.status);
    expect(message ?? "").toContain(String(output.exitCode));
    expect(message ?? "").toContain(String(sync.skipped.length));
  });
});
