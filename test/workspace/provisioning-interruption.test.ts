import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { provisionProjectWorkspace } from "../../src/supervisor/readiness/provisioning.js";
import { ProvisionFence } from "../../src/supervisor/readiness/provision-fence.js";
import type { WorkspaceCommandResult } from "../../src/workspace/commands/command-result.js";
import type { WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

test("an interrupted plan keeps the exclusion until its RPC settles", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const rpc = { settle: (): void => {} };

  const host: WorkspaceHostRpc<"provision" | "ensureManagedInstructions"> = {
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

  const fence = new ProvisionFence();

  const plan = Effect.runFork(
    provisionProjectWorkspace({
      workspaceName,
      fence,
      project: sampleProjectOne,
      namespace: namespaceFor(host),
    }),
  );

  await tick();
  const interrupted = Effect.runPromise(Fiber.interrupt(plan));
  let admitted = false;

  const turn = Effect.runPromise(fence.wait(sampleProjectOne.id)).then(() => {
    admitted = true;
  });

  await tick();

  expect(admitted, "no turn enters while the clone RPC can still write").toBe(false);

  rpc.settle();
  await interrupted;
  await turn;

  expect(admitted).toBe(true);
  vi.restoreAllMocks();
});
