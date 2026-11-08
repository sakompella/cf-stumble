import * as Result from "effect/Result";
import { expect, test, vi } from "vitest";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import type { WorkspaceCommandResult } from "../../src/workspace/commands/command-result.js";
import {
  parseProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "../../src/workspace/commands/provision-project.js";
import { ProvisionUnavailable } from "../../src/workspace/provisioning.js";
import { provisionerFor, ScriptedProvisionHost, TENANT_WORKSPACE } from "./provisioning-fakes.js";

test("clones and then writes the managed instructions into the tenant's workspace", async () => {
  const host = new ScriptedProvisionHost();
  const { provision, namespace } = provisionerFor(host);

  const provisioned = await provision();

  if (Result.isFailure(provisioned)) {
    throw new Error(`provisioning a catalog project must succeed: ${provisioned.failure._tag}`);
  }

  expect(host.requests).toEqual([
    {
      kind: "provision-project",
      projectId: sampleProjectOne.id,
      repositoryUrl: sampleProjectOne.repositoryUrl,
    },
  ]);
  expect(host.steps, "the managed file is written through its own Host RPC").toEqual([
    "clone",
    "instructions",
  ]);
  expect(namespace.names, "one project reaches the tenant's one workspace").toEqual([
    TENANT_WORKSPACE,
  ]);
});

test("carries a resolved project, never command text", async () => {
  const host = new ScriptedProvisionHost();

  await provisionerFor(host).provision();

  const sent = JSON.stringify(host.requests);
  expect(sent).toContain(sampleProjectOne.repositoryUrl);
  expect(sent).not.toContain("git ");
  expect(sent).not.toContain('clone "');
  expect(
    parseProjectProvisionRequest({
      kind: "provision-project",
      projectId: sampleProjectOne.id,
      repositoryUrl: sampleProjectTwo.repositoryUrl,
    }),
    "an id that is not the one the URL derives is refused",
  ).toEqual({ ok: false, error: { code: "invalid-request" } });
});

test.each<readonly ["clone" | "instructions" | undefined, readonly string[], object | undefined]>([
  [
    "clone",
    ["clone", "clone", "instructions"],
    expect.objectContaining({ _tag: "ProvisionFailed", exitCode: 128 }),
  ],
  [
    "instructions",
    ["clone", "instructions", "clone", "instructions"],
    expect.objectContaining({ _tag: "ProvisionUnavailable" }),
  ],
  [undefined, ["clone", "instructions", "clone", "instructions"], undefined],
])(
  "a provision after a run that failed at %s reconciles from scratch and asks for the same state",
  async (failingStep, steps, expectedFailure) => {
    const host = new ScriptedProvisionHost();
    const { provision } = provisionerFor(host);
    const clean = new ScriptedProvisionHost();
    await provisionerFor(clean).provision();

    host.failingStep = failingStep;
    const first = await provision();
    host.failingStep = undefined;
    const second = await provision();

    if (Result.isFailure(second)) {
      throw new Error("a provision after a failed one must succeed");
    }

    expect(Result.isFailure(first) ? first.failure : undefined).toEqual(expectedFailure);
    expect(host.steps, "a failed step stops the plan and the next request starts over").toEqual(
      steps,
    );
    expect(
      host.plans.slice(-clean.plans.length),
      "the later run plans exactly what an uninterrupted run plans",
    ).toEqual(clean.plans);
    expect(host.plans[0], "the earlier run asked for the same reconciliation").toEqual(
      host.plans.at(-1),
    );
  },
);

test("keeps a refused or unreachable workspace one typed failure", async () => {
  const refusing = new ScriptedProvisionHost();
  refusing.provision = (request: ProjectProvisionRequest): Promise<WorkspaceCommandResult> => {
    refusing.requests.push(request);

    return Promise.resolve({ ok: false, error: { code: "unknown-command" } });
  };

  const throwing = new ScriptedProvisionHost();
  throwing.provision = (): Promise<WorkspaceCommandResult> =>
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
