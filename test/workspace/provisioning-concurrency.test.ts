import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { provisionProjectWorkspace } from "../../src/workspace/provisioning.js";
import { delayedProvisionHost, NeverSettlingProvisionHost } from "./provisioning-fakes.js";
import { runToResult } from "./workspace-results.js";

test("serializes different projects in one shared workspace", async () => {
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

  const second = runToResult(
    provisionProjectWorkspace({
      workspaceName: sharedWorkspace,
      project: sampleProjectTwo,
      namespace,
    }),
  );

  await Promise.resolve();

  expect(delayed.host.steps).toEqual(["clone"]);

  delayed.release();

  expect(Result.isSuccess(await first)).toBe(true);
  expect(Result.isSuccess(await second)).toBe(true);
  expect(delayed.host.requests.map((request) => request.projectId)).toEqual([
    sampleProjectOne.id,
    sampleProjectTwo.id,
  ]);
  expect(delayed.host.steps).toEqual(["clone", "instructions", "clone", "instructions"]);
});

test("serializes replacement provisioning until an aborted run has finished", async () => {
  const delayed = delayedProvisionHost();
  const workspaceName = tenantWorkspaceName("provisioning-serializes-replacement");
  const controller = new AbortController();

  const first = runToResult(
    provisionProjectWorkspace({
      workspaceName,
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
      signal: controller.signal,
    }),
  );

  await delayed.started;
  controller.abort();

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

  expect(Result.isFailure(await first)).toBe(true);
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
    const controller = new AbortController();

    const retry = runToResult(
      provisionProjectWorkspace({
        workspaceName: tenantWorkspaceName("never-settling-original"),
        project: sampleProjectOne,
        namespace,
        signal: controller.signal,
      }),
    );

    controller.abort();

    const timeout = new Promise<"timed-out">((resolve) => {
      setTimeout(() => {
        resolve("timed-out");
      }, 100);
    });

    const outcome = await Promise.race([retry, timeout]);

    expect(outcome).not.toBe("timed-out");

    if (outcome !== "timed-out") {
      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe("ProvisionUnavailable");
    }
  }

  expect(host.requests, "retries must not append work behind the lost RPC").toHaveLength(1);
  void first;
});
