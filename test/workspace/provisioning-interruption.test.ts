import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleCatalog, sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import {
  provisionProjectWorkspace,
  waitForWorkspaceProvision,
  type ProvisionWorkspaceHost,
} from "../../src/workspace/provisioning.js";
import type { WorkspaceResult } from "../../src/workspace/decisions.js";

/**
 * A provision plan whose caller is interrupted still holds the workspace exclusion until its
 * Workspace Host RPC settles. The RPC cannot be recalled once sent, so a turn admitted early could
 * work in a directory the old clone is still writing.
 */

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

test("an interrupted plan keeps the exclusion until its RPC settles", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const rpc = { settle: (): void => {} };

  const host: ProvisionWorkspaceHost = {
    provision: (request) =>
      request.step === "clone"
        ? new Promise<WorkspaceResult>((resolve) => {
            rpc.settle = () => {
              resolve({
                ok: true,
                result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
              });
            };
          })
        : Promise.resolve({ ok: true, result: { kind: "written" } }),
  };

  const workspaceName = tenantWorkspaceName("interrupted-provision");

  const plan = Effect.runFork(
    provisionProjectWorkspace({
      workspaceName,
      projectId: sampleProjectOne.id,
      catalog: sampleCatalog,
      namespace: namespaceFor(host),
    }),
  );

  await tick();
  const interrupted = Effect.runPromise(Fiber.interrupt(plan));
  let admitted = false;

  const turn = waitForWorkspaceProvision(workspaceName).then((admit) => {
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
