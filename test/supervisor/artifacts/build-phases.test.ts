import { expect, test } from "vitest";
import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
import {
  HARNESS_BUILD_CONFIGURATION,
  planHarnessBuild,
  type HarnessBuildRequest,
} from "../../../src/harness-build.js";
import { WorkspaceHostModuleMapBuilder } from "../../../src/supervisor/artifacts/index.js";
import type {
  BuildWorkspaceHost,
  BuildWorkspaceNamespace,
} from "../../../src/supervisor/artifacts/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import type { WorkspaceResult } from "../../../src/workspace/index.js";

/**
 * Why a build has one step per phase. Three deployed builds of one commit died at 671 s, 692 s
 * and 696 s: two lost the Durable Object, and one exited 1 with an empty stdout and an empty
 * stderr. Every one of them reported the whole build as `build` and left nothing behind that said
 * which phase had been running. A phase is now its own step, so it is its own RPC, its own exit
 * code and its own bounded tail, and no one command has to survive eleven minutes.
 */

const commit = harnessCommit("6000000000000000000000000000000000000003");
const workspaceName = tenantWorkspaceName("supervisor-name-of-this-tenant");
const phaseNames = HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.name);

function harnessCommit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);
  if (parsed === undefined) {
    throw new Error("the test commits must be valid harness commits");
  }

  return parsed;
}

/** Fails the one step the test names and reports every step it was asked for. */
class PhaseFailingHost implements BuildWorkspaceHost {
  readonly steps: string[] = [];
  private readonly failing: string;

  constructor(failing: string) {
    this.failing = failing;
  }

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    if (request.kind === "build-output") {
      this.steps.push("build-output");
      return Promise.resolve({
        ok: true,
        result: { kind: "command", stdout: "{}", stderr: "", exitCode: 0 },
      });
    }

    this.steps.push(request.step);
    const failed = request.step === this.failing;
    return Promise.resolve({
      ok: true,
      result: {
        kind: "command",
        stdout: "",
        stderr: failed ? `${request.step} failed` : "",
        exitCode: failed ? 7 : 0,
      },
    });
  }
}

class OneHostNamespace implements BuildWorkspaceNamespace {
  readonly host: BuildWorkspaceHost;

  constructor(host: BuildWorkspaceHost) {
    this.host = host;
  }

  getByName(): BuildWorkspaceHost {
    return this.host;
  }
}

test("plans each build phase as its own step, in the order the phases depend on", () => {
  const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);

  expect(plan.steps.map((step) => step.name)).toEqual([
    "provision",
    "isolate",
    "checkout",
    ...phaseNames,
  ]);
  for (const phase of HARNESS_BUILD_CONFIGURATION.buildPhases) {
    const own = plan.steps.filter((step) => step.source.includes(phase.command));
    expect(
      own.map((step) => step.name),
      `${phase.command} belongs to the ${phase.name} step and to no other`,
    ).toEqual([phase.name]);
  }
});

test("a failing phase names that phase, and the phases after it never run", async () => {
  const outcomes = await Promise.all(
    phaseNames.map(async (failing) => {
      const host = new PhaseFailingHost(failing);
      const built = await new WorkspaceHostModuleMapBuilder(
        new OneHostNamespace(host),
        workspaceName,
      ).build(commit);
      return { failing, error: built.isErr() ? built.error : undefined, steps: host.steps };
    }),
  );

  for (const outcome of outcomes) {
    expect(outcome.error, `the ${outcome.failing} phase must report its own failure`).toEqual({
      code: "build-step-failed",
      harnessCommit: commit,
      step: outcome.failing,
      exitCode: 7,
    });
    expect(outcome.steps.at(-1), "a build stops at the phase that failed").toBe(outcome.failing);
    expect(
      outcome.steps.slice(0, 3),
      "and the phases still run after the commit is provisioned, isolated and extracted",
    ).toEqual(["provision", "isolate", "checkout"]);
  }
});
