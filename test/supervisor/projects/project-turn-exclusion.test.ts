/// <reference types="@cloudflare/vitest-plugin/types" />

import { Result } from "better-result";
import { expect, test } from "vitest";
import {
  sampleCatalog,
  sampleSelectableCatalog,
  sampleProjectOne,
} from "../../project-fixtures.js";
import { HARNESS_PROJECT_ID } from "../../../src/selectable-projects.js";
import { streamProjectTurn } from "../../../src/supervisor/projects/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import {
  provisionProjectWorkspace,
  type ProvisionWorkspaceHost,
  type ProvisionWorkspaceNamespace,
  type WorkspaceResult,
} from "../../../src/workspace/index.js";
import type { ProjectWorkspaceNamespace } from "../../../src/supervisor/projects/index.js";
import type { ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the fake facet never calls this capability; the test only observes when it is obtained.
const unusedCapability = {} as ProjectRpcTargetContract;

type DelayedWorkspace = Readonly<{
  namespace: ProvisionWorkspaceNamespace & ProjectWorkspaceNamespace;
  started: Promise<void>;
  release(): void;
  projectCalls(): number;
}>;

function delayedWorkspace(): DelayedWorkspace {
  let releaseClone: (() => void) | undefined;
  let cloneStarted: (() => void) | undefined;

  let projectCalls = 0;
  let provisionCalls = 0;

  const started = new Promise<void>((resolve) => {
    cloneStarted = resolve;
  });

  const host: ProvisionWorkspaceHost & { project(): Promise<ProjectRpcTargetContract> } = {
    provision(request): Promise<WorkspaceResult> {
      provisionCalls += 1;

      if (provisionCalls === 1) {
        cloneStarted?.();

        return new Promise((resolve) => {
          releaseClone = () => {
            resolve({
              ok: true,
              result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
            });
          };
        });
      }

      return Promise.resolve(
        request.step === "clone"
          ? { ok: true, result: { kind: "command", stdout: "", stderr: "", exitCode: 0 } }
          : { ok: true, result: { kind: "written" } },
      );
    },
    project: () => {
      projectCalls += 1;

      return Promise.resolve(unusedCapability);
    },
  };

  const namespace: ProvisionWorkspaceNamespace & ProjectWorkspaceNamespace = {
    getByName: () => host,
  };

  return {
    namespace,
    started,
    release: () => {
      releaseClone?.();
    },
    projectCalls: () => projectCalls,
  };
}

test("a harness turn waits for a project provision in the shared workspace", async () => {
  const delayed = delayedWorkspace();
  const workspace = tenantWorkspaceName("harness-waits-for-provision");

  const first = provisionProjectWorkspace({
    workspaceName: workspace,
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace: delayed.namespace,
  });

  await delayed.started;

  let mounted = false;

  const facet = {
    startTurn: () => Promise.resolve(new ReadableStream<Uint8Array>()),
  };

  const harness = streamProjectTurn({
    namespace: delayed.namespace,
    mount: () => {
      mounted = true;

      return Promise.resolve(Result.ok({ fetcher: facet }));
    },
    provision: () => Promise.resolve(true),
    catalog: sampleSelectableCatalog,
    workspaceName: workspace,
    projectId: HARNESS_PROJECT_ID,
    request: { prompt: "do the work", state: null },
    signal: new AbortController().signal,
  });

  await Promise.resolve();
  expect(mounted, "the harness must not mount while provisioning can still write").toBe(false);
  expect(delayed.projectCalls(), "the harness must not obtain a workspace capability yet").toBe(0);

  delayed.release();

  expect((await first).isOk()).toBe(true);
  expect((await harness).ok).toBe(true);
  expect(delayed.projectCalls()).toBe(1);
});
