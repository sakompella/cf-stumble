import { expect, test } from "vitest";
import {
  MANAGED_AGENT_INSTRUCTIONS,
  PROJECT_PROVISION_CONFIGURATION,
  type ProjectProvisionStepName,
} from "../../src/project-provision.js";
import { PROJECT_CATALOG } from "../../src/project-catalog.js";
import { deriveProjectWorkspaceName } from "../../src/workspace-names.js";
import {
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
  provisionProjectWorkspace,
  type ProjectProvisionRequest,
  type ProvisionWorkspaceHost,
  type WorkspacePlan,
  type WorkspaceResult,
} from "../../src/workspace/index.js";

/**
 * WHAT THESE TESTS ESTABLISH, AND WHAT THEY DO NOT.
 *
 * They establish which requests the caller sends, in what order, that it repeats every step
 * instead of remembering one, and that the plan a resumed run produces is byte-identical to the
 * plan an uninterrupted run produces. The fake host below is not a stand-in for a shell: it runs
 * the real `parseProjectProvisionRequest` and `planProjectProvisionRequest`, so what it records is
 * the same text the Workspace Host would hand to Computer.
 *
 * They do not establish that provisioning works. No test in this repository can run a shell: the
 * Workers vitest pool has no `node:child_process`, and the only Node project in vitest.config.ts
 * matches property test files alone. So `git clone` is never executed, no remote is contacted, and
 * the reconciliation is checked as text rather than as behavior. That is not a hypothetical gap.
 * This exact test shape passed while `shellQuote` emitted quoting no shell could parse (fixed in
 * f2fe291), and again while the whole provision step was inert because the container had
 * `egress: none`. Convergence here means "asks for the same thing again", not "ends in the same
 * filesystem state".
 */

const tenant = { identity: "tenant-1", audience: "test-audience" } as const;
const [projectOne] = PROJECT_CATALOG;

/**
 * Answers only the requests the real provision surface accepts, and plans them the way the real
 * host does, so a request the caller should never send fails the test instead of passing quietly.
 */
class FakeProvisionHost implements ProvisionWorkspaceHost {
  readonly requests: ProjectProvisionRequest[] = [];
  readonly plans: WorkspacePlan[] = [];
  failingStep: ProjectProvisionStepName | undefined;

  provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
    this.requests.push(request);
    const parsed = parseProjectProvisionRequest(request);
    if ("ok" in parsed) {
      return Promise.resolve(parsed);
    }

    const plan = planProjectProvisionRequest(PROJECT_PROVISION_CONFIGURATION, parsed);
    this.plans.push(plan);
    if (request.step === this.failingStep) {
      // A clone reports failure through its exit code; a write has none, so the host redacts it
      // into a refusal, which is what the real surface returns when Computer throws.
      return Promise.resolve(
        plan.kind === "run-command"
          ? {
              ok: true,
              result: {
                kind: "command",
                stdout: "",
                stderr: "fatal: could not read from remote repository",
                exitCode: 128,
              },
            }
          : { ok: false, error: { code: "workspace-unavailable" } },
      );
    }

    return Promise.resolve(
      plan.kind === "run-command"
        ? { ok: true, result: { kind: "command", stdout: "", stderr: "", exitCode: 0 } }
        : { ok: true, result: { kind: "written" } },
    );
  }
}

class FakeProvisionNamespace {
  readonly names: string[] = [];
  readonly host: FakeProvisionHost;

  constructor(host: FakeProvisionHost) {
    this.host = host;
  }

  getByName(name: string): FakeProvisionHost {
    this.names.push(name);
    return this.host;
  }
}

function provisionerFor(host: FakeProvisionHost) {
  const namespace = new FakeProvisionNamespace(host);
  return {
    namespace,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This helper passes test values to the public parsing boundary.
    provision: (projectId: unknown = projectOne.id) =>
      provisionProjectWorkspace({ ...tenant, projectId, namespace }),
  };
}

function stepsOf(host: FakeProvisionHost): ProjectProvisionStepName[] {
  return host.requests.map((request) => request.step);
}

test("clones and then writes the managed instructions into the derived workspace", async () => {
  const host = new FakeProvisionHost();
  const { provision, namespace } = provisionerFor(host);

  const provisioned = await provision();

  if (provisioned.isErr()) {
    throw new Error(`provisioning a catalog project must succeed: ${provisioned.error.code}`);
  }
  expect(provisioned.value).toEqual({
    projectId: projectOne.id,
    workspaceName: await deriveProjectWorkspaceName({ ...tenant, project: projectOne }),
  });
  expect(host.requests).toEqual([
    { kind: "provision-project", projectId: projectOne.id, step: "clone" },
    { kind: "provision-project", projectId: projectOne.id, step: "instructions" },
  ]);
  expect(namespace.names).toEqual([provisioned.value.workspaceName]);
  expect(namespace.names[0]?.startsWith("access:")).toBe(true);
});

test("carries a project id and a step name, never a repository URL or command text", async () => {
  const host = new FakeProvisionHost();

  await provisionerFor(host).provision();

  const sent = JSON.stringify(host.requests);
  expect(sent).not.toContain("http");
  expect(sent).not.toContain("git ");
  expect(sent).not.toContain(projectOne.repositoryUrl);
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

  if (interrupted.isOk() || resumed.isErr()) {
    throw new Error("an interrupted clone must recover on the next provision request");
  }
  expect(interrupted.error).toEqual({
    code: "provision-step-failed",
    projectId: projectOne.id,
    step: "clone",
    exitCode: 128,
  });
  expect(stepsOf(host), "a failed clone stops before the instructions").toEqual([
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

  if (interrupted.isOk() || resumed.isErr()) {
    throw new Error("a failed instructions write must recover on the next provision request");
  }
  expect(interrupted.error).toEqual({
    code: "provision-workspace-unavailable",
    projectId: projectOne.id,
    step: "instructions",
  });
  expect(stepsOf(host)).toEqual(["clone", "instructions", "clone", "instructions"]);
  expect(host.plans.at(-1)).toEqual({
    kind: "write-file",
    path: PROJECT_PROVISION_CONFIGURATION.agentInstructionsPath,
    content: MANAGED_AGENT_INSTRUCTIONS,
  });
});

test("reconciles again on a plain repeat, holding no memory of the last run", async () => {
  const host = new FakeProvisionHost();
  const { provision } = provisionerFor(host);

  await provision();
  await provision();

  expect(stepsOf(host)).toEqual(["clone", "instructions", "clone", "instructions"]);
  expect(host.plans.slice(2)).toEqual(host.plans.slice(0, 2));
});

test("refuses a project the catalog does not resolve before naming a workspace", async () => {
  const host = new FakeProvisionHost();
  const { provision, namespace } = provisionerFor(host);

  const refusals = [
    await provision("no-such-project"),
    await provision("../../etc"),
    await provision(7),
  ];

  expect(refusals.map((refusal) => (refusal.isErr() ? refusal.error : "ok"))).toEqual([
    { code: "project-not-in-catalog", reason: "unknown-project-id" },
    { code: "project-not-in-catalog", reason: "invalid-project-id" },
    { code: "project-not-in-catalog", reason: "invalid-project-id" },
  ]);
  expect(namespace.names, "a refused project reaches no workspace").toEqual([]);
  expect(host.requests).toEqual([]);
});

test("keeps a refused or unreachable workspace a plain typed failure", async () => {
  const refusing = new FakeProvisionHost();
  refusing.provision = (request: ProjectProvisionRequest): Promise<WorkspaceResult> => {
    refusing.requests.push(request);
    return Promise.resolve({ ok: false, error: { code: "unknown-command" } });
  };
  const throwing = new FakeProvisionHost();
  throwing.provision = (): Promise<WorkspaceResult> =>
    Promise.reject(new Error("fake workspace host failure"));

  const results = [
    await provisionerFor(refusing).provision(),
    await provisionerFor(throwing).provision(),
  ];

  expect(results.map((result) => (result.isErr() ? result.error : "ok"))).toEqual([
    { code: "provision-workspace-unavailable", projectId: projectOne.id, step: "clone" },
    { code: "provision-workspace-unavailable", projectId: projectOne.id, step: "clone" },
  ]);
  expect(
    results.every(
      (result) => result.isErr() && Object.getPrototypeOf(result.error) === Object.prototype,
    ),
    "a provisioning failure stays a value a caller can return over RPC",
  ).toBe(true);
});
