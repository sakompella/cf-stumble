import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { projectIdOf, sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import {
  clearWorkspaceProvision,
  waitForWorkspaceProvision,
} from "../../src/supervisor/readiness/provision-fence.js";
import { provisionProjectWorkspace } from "../../src/supervisor/readiness/provisioning.js";
import { delayedProvisionHost, NeverSettlingProvisionHost } from "./provisioning-fakes.js";
import { runInterruptible, runToResult } from "./workspace-results.js";

test("provisions different projects in one shared workspace side by side", async () => {
  const delayed = delayedProvisionHost();
  const namespace = namespaceFor(delayed.host);
  const sharedWorkspace = tenantWorkspaceName("different-projects-shared-workspace");

  const first = runToResult(
    provisionProjectWorkspace({
      workspaceName: sharedWorkspace,
      project: sampleProjectOne,
      namespace,
    }),
  );

  await delayed.started;

  const second = await runToResult(
    provisionProjectWorkspace({
      workspaceName: sharedWorkspace,
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
  const workspaceName = tenantWorkspaceName("provision-holds-its-project");

  const admitted = (projectId: typeof sampleProjectOne.id) =>
    Effect.runPromise(
      waitForWorkspaceProvision(workspaceName, projectId).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration: 50, orElse: () => Effect.succeed(false) }),
      ),
    );

  const provisioning = runToResult(
    provisionProjectWorkspace({
      workspaceName,
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
    }),
  );

  await delayed.started;

  expect(await admitted(sampleProjectTwo.id)).toBe(true);
  expect(await admitted(projectIdOf("harness"))).toBe(true);
  expect(await admitted(sampleProjectOne.id)).toBe(false);

  clearWorkspaceProvision(workspaceName);

  expect(await admitted(sampleProjectOne.id)).toBe(true);

  delayed.release();
  await provisioning;
});

test("serializes replacement provisioning until an interrupted run has finished", async () => {
  const delayed = delayedProvisionHost();
  const workspaceName = tenantWorkspaceName("provisioning-serializes-replacement");

  const first = runInterruptible(
    provisionProjectWorkspace({
      workspaceName,
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
    }),
  );

  await delayed.started;
  first.interrupt();

  const replacement = runToResult(
    provisionProjectWorkspace({
      workspaceName,
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
    }),
  );

  await Promise.resolve();

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

  const first = runToResult(
    provisionProjectWorkspace({
      workspaceName: tenantWorkspaceName("never-settling-original"),
      project: sampleProjectOne,
      namespace,
    }),
  );

  await Promise.resolve();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retry = runInterruptible(
      provisionProjectWorkspace({
        workspaceName: tenantWorkspaceName("never-settling-original"),
        project: sampleProjectOne,
        namespace,
      }),
    );

    retry.interrupt();

    const timeout = new Promise<"timed-out">((resolve) => {
      setTimeout(() => {
        resolve("timed-out");
      }, 100);
    });

    const outcome = await Promise.race([retry.interrupted, timeout]);

    expect(outcome, "a waiting retry leaves the queue when it is interrupted").not.toBe(
      "timed-out",
    );
  }

  expect(host.requests, "retries must not append work behind the lost RPC").toHaveLength(1);
  void first;
});
