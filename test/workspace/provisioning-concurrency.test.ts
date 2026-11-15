import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { projectIdOf, sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import { ProvisionFence } from "../../src/supervisor/readiness/provision-fence.js";
import { provisionProjectWorkspace } from "../../src/supervisor/readiness/provisioning.js";
import {
  delayedProvisionHost,
  NeverSettlingProvisionHost,
  TENANT_WORKSPACE,
} from "./provisioning-fakes.js";
import { runInterruptible, runToResult } from "./workspace-results.js";
import { tick } from "../eventually.js";

function admitted(fence: ProvisionFence, projectId: typeof sampleProjectOne.id) {
  const state = { admitted: false };

  const done = Effect.runPromise(fence.wait(projectId)).then(() => {
    state.admitted = true;
  });

  return { done, state };
}

test("provisions different projects in one shared workspace side by side", async () => {
  const delayed = delayedProvisionHost();
  const namespace = namespaceFor(delayed.host);
  const sharedWorkspace = TENANT_WORKSPACE;
  const fence = new ProvisionFence();

  const first = runToResult(
    provisionProjectWorkspace({
      workspaceName: sharedWorkspace,
      fence,
      project: sampleProjectOne,
      namespace,
    }),
  );

  await delayed.started;

  const second = await runToResult(
    provisionProjectWorkspace({
      workspaceName: sharedWorkspace,
      fence,
      project: sampleProjectTwo,
      namespace,
    }),
  );

  expect(Result.isSuccess(second)).toBe(true);
  expect(delayed.host.steps).toEqual(["clone", "clone", "instructions"]);

  delayed.release();

  expect(Result.isSuccess(await first)).toBe(true);
  expect(delayed.host.requests.map((request) => request.projectId)).toEqual([
    sampleProjectOne.id,
    sampleProjectTwo.id,
  ]);
});

test("holds a project's turns during its own provision only, until a reset clears them all", async () => {
  const delayed = delayedProvisionHost();
  const workspaceName = TENANT_WORKSPACE;
  const fence = new ProvisionFence();

  const provisioning = runToResult(
    provisionProjectWorkspace({
      workspaceName,
      fence,
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
    }),
  );

  await delayed.started;

  const others = [admitted(fence, sampleProjectTwo.id), admitted(fence, projectIdOf("harness"))];
  const own = admitted(fence, sampleProjectOne.id);

  await Promise.all(others.map((turn) => turn.done));
  await tick();

  expect(own.state.admitted).toBe(false);

  fence.clear();
  const afterReset = admitted(fence, sampleProjectOne.id);

  await afterReset.done;
  expect(afterReset.state.admitted).toBe(true);

  delayed.release();
  await provisioning;
});

test("serializes replacement provisioning until an interrupted run has finished", async () => {
  const delayed = delayedProvisionHost();
  const workspaceName = TENANT_WORKSPACE;
  const fence = new ProvisionFence();

  const first = runInterruptible(
    provisionProjectWorkspace({
      workspaceName,
      fence,
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
    }),
  );

  await delayed.started;
  first.interrupt();

  const replacement = runToResult(
    provisionProjectWorkspace({
      workspaceName,
      fence,
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
    }),
  );

  await tick();

  expect(
    delayed.host.steps,
    "a replacement must not enter the shared workspace while the aborted clone is in flight",
  ).toEqual(["clone"]);

  delayed.release();

  await expect(first.interrupted).resolves.toBe(true);
  expect(Result.isSuccess(await replacement)).toBe(true);
  expect(delayed.host.steps).toEqual(["clone", "clone", "instructions"]);
});

test("does not queue retries behind a never-settling provision RPC", async () => {
  const host = new NeverSettlingProvisionHost();
  const namespace = namespaceFor(host);
  const fence = new ProvisionFence();

  const first = runToResult(
    provisionProjectWorkspace({
      workspaceName: TENANT_WORKSPACE,
      fence,
      project: sampleProjectOne,
      namespace,
    }),
  );

  await tick();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retry = runInterruptible(
      provisionProjectWorkspace({
        workspaceName: TENANT_WORKSPACE,
        fence,
        project: sampleProjectOne,
        namespace,
      }),
    );

    retry.interrupt();

    await expect(
      retry.interrupted,
      "a waiting retry leaves the queue when it is interrupted",
    ).resolves.toBe(true);
  }

  expect(host.requests, "retries must not append work behind the lost RPC").toHaveLength(1);
  void first;
});
