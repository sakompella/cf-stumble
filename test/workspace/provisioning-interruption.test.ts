import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import {
  provisionProjectWorkspace,
  type ProvisionWorkspaceHost,
} from "../../src/workspace/provisioning.js";
import { waitForWorkspaceProvision } from "../../src/workspace/provision-exclusion.js";
import type { WorkspaceCommandResult } from "../../src/workspace/decisions.js";

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

test("an interrupted plan keeps the exclusion until its RPC settles", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const rpc = { settle: (): void => {} };

  const host: ProvisionWorkspaceHost = {
    provision: () =>
      new Promise<WorkspaceCommandResult>((resolve) => {
        rpc.settle = () => {
          resolve({
            ok: true,
            result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
          });
        };
      }),
    ensureManagedInstructions: () => Promise.resolve({ ok: true, result: { kind: "written" } }),
  };

  const workspaceName = tenantWorkspaceName("interrupted-provision");

  const plan = Effect.runFork(
    provisionProjectWorkspace({
      workspaceName,
      project: sampleProjectOne,
      namespace: namespaceFor(host),
    }),
  );

  await tick();
  const interrupted = Effect.runPromise(Fiber.interrupt(plan));
  let admitted = false;

  const turn = Effect.runPromise(
    waitForWorkspaceProvision(workspaceName, sampleProjectOne.id),
  ).then((admit) => {
    admitted = admit;
  });

  await tick();

  expect(admitted, "no turn enters while the clone RPC can still write").toBe(false);

  rpc.settle();
  await interrupted;
  await turn;

  expect(admitted).toBe(true);
  vi.restoreAllMocks();
});
