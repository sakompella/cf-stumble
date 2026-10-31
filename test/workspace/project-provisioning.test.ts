import * as Result from "effect/Result";
import { expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import {
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
  type ProjectProvisionRequest,
  type ProvisionWorkspaceHost,
  type WorkspacePlan,
  type WorkspaceResult,
} from "../../src/workspace/index.js";
import {
  provisionProjectWorkspace,
  ProvisionFailed,
  ProvisionUnavailable,
} from "../../src/workspace/provisioning.js";
import type { Project } from "../../src/project-catalog.js";
import { runToResult } from "./workspace-results.js";

const workspaceName = tenantWorkspaceName("supervisor-name-of-tenant-1");

const projectOne = sampleProjectOne;

class FakeProvisionHost implements ProvisionWorkspaceHost {
  readonly requests: ProjectProvisionRequest[] = [];
  readonly plans: WorkspacePlan[] = [];
  readonly steps: string[] = [];
  failingStep: "clone" | "instructions" | undefined;

  provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
    this.requests.push(request);
    this.steps.push("clone");
    const parsed = parseProjectProvisionRequest(request);

    if ("ok" in parsed) {
      return Promise.resolve(parsed);
    }

    const plan = planProjectProvisionRequest(parsed);
    this.plans.push(plan);

    return Promise.resolve({
      ok: true,
      result:
        this.failingStep === "clone"
          ? {
              kind: "command",
              stdout: "",
              stderr: "fatal: could not read from remote repository",
              exitCode: 128,
            }
          : { kind: "command", stdout: "", stderr: "", exitCode: 0 },
    });
  }

  ensureManagedInstructions(): Promise<WorkspaceResult> {
    this.steps.push("instructions");

    return Promise.resolve(
      this.failingStep === "instructions"
        ? { ok: false, error: { code: "workspace-unavailable" } }
        : { ok: true, result: { kind: "written" } },
    );
  }
}

function provisionerFor(host: FakeProvisionHost) {
  const namespace = namespaceFor(host);

  return {
    namespace,
    provision: (project: Project = projectOne) =>
      runToResult(provisionProjectWorkspace({ workspaceName, project, namespace })),
  };
}

test("namespace fixtures record names independently", () => {
  const host = new FakeProvisionHost();
  const first = namespaceFor(host);
  const second = namespaceFor(host);

  first.getByName("first-workspace");
  second.getByName("second-workspace");

  expect(first.names).toEqual(["first-workspace"]);
  expect(second.names).toEqual(["second-workspace"]);
});

test("clones and then writes the managed instructions into the tenant's workspace", async () => {
  const host = new FakeProvisionHost();
  const { provision, namespace } = provisionerFor(host);

  const provisioned = await provision();

  if (Result.isFailure(provisioned)) {
    throw new Error(`provisioning a catalog project must succeed: ${provisioned.failure._tag}`);
  }

  expect(host.requests).toEqual([
    {
      kind: "provision-project",
      projectId: projectOne.id,
      repositoryUrl: projectOne.repositoryUrl,
    },
  ]);
  expect(host.steps, "the managed file is written through its own Host RPC").toEqual([
    "clone",
    "instructions",
  ]);
  expect(namespace.names, "one project reaches the tenant's one workspace").toEqual([
    workspaceName,
  ]);
});

test("carries a resolved project, never command text", async () => {
  const host = new FakeProvisionHost();

  await provisionerFor(host).provision();

  const sent = JSON.stringify(host.requests);
  expect(sent).toContain(projectOne.repositoryUrl);
  expect(sent).not.toContain("git ");
  expect(sent).not.toContain('clone "');
  expect(
    parseProjectProvisionRequest({
      kind: "provision-project",
      projectId: projectOne.id,
      repositoryUrl: sampleProjectTwo.repositoryUrl,
    }),
    "an id that is not the one the URL derives is refused",
  ).toEqual({ ok: false, error: { code: "invalid-request" } });
});

test("an interrupted provision and its resumption ask for the same state", async () => {
  const host = new FakeProvisionHost();
  const { provision } = provisionerFor(host);
  const clean = new FakeProvisionHost();
  await provisionerFor(clean).provision();

  host.failingStep = "clone";
  const interrupted = await provision();
  host.failingStep = undefined;
  const resumed = await provision();

  if (Result.isSuccess(interrupted) || Result.isFailure(resumed)) {
    throw new Error("an interrupted clone must recover on the next provision request");
  }

  expect(interrupted.failure).toMatchObject({ _tag: "ProvisionFailed", exitCode: 128 });
  expect(interrupted.failure).toBeInstanceOf(ProvisionFailed);
  expect(host.steps, "a failed clone stops before the instructions step").toEqual([
    "clone",
    "clone",
    "instructions",
  ]);
  expect(
    host.plans.slice(1),
    "the resumed run plans exactly what an uninterrupted run plans",
  ).toEqual(clean.plans);
  expect(host.plans[0], "the interrupted clone asked for the same reconciliation").toEqual(
    host.plans[1],
  );
});

test("repeats the clone after the instructions step failed, rather than resuming mid-plan", async () => {
  const host = new FakeProvisionHost();
  const { provision } = provisionerFor(host);

  host.failingStep = "instructions";
  const interrupted = await provision();
  host.failingStep = undefined;
  const resumed = await provision();

  if (Result.isSuccess(interrupted) || Result.isFailure(resumed)) {
    throw new Error("a failed instructions write must recover on the next provision request");
  }

  expect(interrupted.failure).toBeInstanceOf(ProvisionUnavailable);
  expect(host.steps).toEqual(["clone", "instructions", "clone", "instructions"]);
});

test("reconciles again on a plain repeat, holding no memory of the last run", async () => {
  const host = new FakeProvisionHost();
  const { provision } = provisionerFor(host);

  await provision();
  await provision();

  expect(host.steps).toEqual(["clone", "instructions", "clone", "instructions"]);
  expect(host.plans.slice(1)).toEqual(host.plans.slice(0, 1));
});

test("keeps a refused or unreachable workspace one typed failure", async () => {
  const refusing = new FakeProvisionHost();
  refusing.provision = (request: ProjectProvisionRequest): Promise<WorkspaceResult> => {
    refusing.requests.push(request);

    return Promise.resolve({ ok: false, error: { code: "unknown-command" } });
  };

  const throwing = new FakeProvisionHost();
  throwing.provision = (): Promise<WorkspaceResult> =>
    Promise.reject(new Error("fake workspace host failure"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  const results = [
    await provisionerFor(refusing).provision(),
    await provisionerFor(throwing).provision(),
  ];

  logged.mockRestore();

  expect(
    results.every(
      (result) => Result.isFailure(result) && result.failure instanceof ProvisionUnavailable,
    ),
    "a provisioning failure is one typed error the caller handles by its class",
  ).toBe(true);
});

test("logs a redacted cause when the workspace provision RPC rejects", async () => {
  const throwing = new FakeProvisionHost();
  const secret = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";
  throwing.provision = (): Promise<WorkspaceResult> =>
    Promise.reject(new Error(`clone failed ${secret} https://${secret}@github.com/sample/repo`));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    await provisionerFor(throwing).provision();

    const output = JSON.stringify(logged.mock.calls);
    expect(output).toContain("[redacted]");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(`https://${secret}@github.com`);
  } finally {
    logged.mockRestore();
  }
});
