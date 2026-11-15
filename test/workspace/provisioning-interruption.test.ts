import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";
import { tick } from "../eventually.js";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { provisionProjectWorkspace } from "../../src/supervisor/readiness/provisioning.js";
import { ProvisionFence } from "../../src/supervisor/readiness/provision-fence.js";
import { delayedProvisionHost } from "./provisioning-fakes.js";

test("an interrupted plan keeps the exclusion until its RPC settles", async () => {
  const delayed = delayedProvisionHost();

  const workspaceName = tenantWorkspaceName("interrupted-provision");

  const fence = new ProvisionFence();

  const plan = Effect.runFork(
    provisionProjectWorkspace({
      workspaceName,
      fence,
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
    }),
  );

  await delayed.started;
  const interrupted = Effect.runPromise(Fiber.interrupt(plan));
  let admitted = false;

  const turn = Effect.runPromise(fence.wait(sampleProjectOne.id)).then(() => {
    admitted = true;
  });

  await tick();

  expect(admitted, "no turn enters while the clone RPC can still write").toBe(false);

  delayed.release();
  await interrupted;
  await turn;

  expect(admitted).toBe(true);
});
