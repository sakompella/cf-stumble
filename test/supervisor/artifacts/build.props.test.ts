import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { HARNESS_BUILD_STEP_NAMES, type HarnessBuildStepName } from "../../../src/harness-build.js";
import type {
  CommandAnswer,
  ModuleMapAnswer,
} from "../../../src/workspace/commands/command-result.js";
import {
  BUILD_COMMIT,
  built,
  entryModule,
  helperModule,
  moduleMapFile,
} from "./scripted-build-host.js";

type StepFault = "exit" | "refused" | "thrown";

type OutputFault = "missing" | "refused" | "unparsable" | "without-entry";

type Scenario = Readonly<{
  step: Readonly<{ name: HarnessBuildStepName; fault: StepFault; exitCode: number }> | null;
  output: OutputFault | null;
  cleanup: "removed" | "exited" | "thrown";
}>;

const scenarios = gs.composite<Scenario>((tc) => {
  const failing = tc.draw(gs.booleans());

  return {
    step: failing
      ? {
          name: tc.draw(gs.sampledFrom(HARNESS_BUILD_STEP_NAMES)),
          fault: tc.draw(gs.sampledFrom(["exit", "refused", "thrown"] as const)),
          exitCode: tc.draw(gs.integers({ minValue: 1, maxValue: 255 })),
        }
      : null,
    output: tc.draw(
      gs.optional(gs.sampledFrom(["missing", "refused", "unparsable", "without-entry"] as const)),
    ),
    cleanup: tc.draw(gs.sampledFrom(["removed", "exited", "thrown"] as const)),
  };
});

function command(exitCode: number): Promise<CommandAnswer> {
  return Promise.resolve({
    ok: true,
    output: { stdout: "", stderr: "", exitCode },
  });
}

const refused: Promise<CommandAnswer> = Promise.resolve({
  ok: false,
  error: { code: "workspace-unavailable" },
});

function mapText(moduleMap: string): Promise<ModuleMapAnswer> {
  return Promise.resolve({ ok: true, moduleMap });
}

const publishFailed: Promise<ModuleMapAnswer> = Promise.resolve({
  ok: false,
  error: { code: "publish-failed", output: { stdout: "", stderr: "", exitCode: 1 } },
});

function stepAnswer(scenario: Scenario, step: string) {
  const fault = scenario.step?.name === step ? scenario.step : null;

  if (fault === null) return command(0);

  if (fault.fault === "exit") return command(fault.exitCode);

  if (fault.fault === "refused") return refused;

  return Promise.reject(new Error("the workspace is gone"));
}

function outputAnswer({ output }: Scenario): Promise<ModuleMapAnswer> {
  if (output === "missing") return publishFailed;

  if (output === "refused")
    return Promise.resolve({ ok: false, error: { code: "workspace-unavailable" } });

  if (output === "unparsable") return mapText("{");

  return mapText(moduleMapFile(output === null ? [helperModule, entryModule] : [helperModule]));
}

function cleanupAnswer({ cleanup }: Scenario): Promise<CommandAnswer> {
  if (cleanup === "thrown") return Promise.reject(new Error("the container stopped"));

  return command(cleanup === "removed" ? 0 : 1);
}

function scripted(scenario: Scenario) {
  const requests: string[] = [];

  const host = {
    build: (request: { harnessCommit: string; step: string }) => {
      requests.push(`${request.step} ${request.harnessCommit}`);

      return stepAnswer(scenario, request.step);
    },
    buildOutput: (harnessCommit: string) => {
      requests.push(`output ${harnessCommit}`);

      return outputAnswer(scenario);
    },
    discardBuild: (harnessCommit: string) => {
      requests.push(`discard ${harnessCommit}`);

      return cleanupAnswer(scenario);
    },
  };

  return { host, requests };
}

function expectedRequests({ step }: Scenario): string[] {
  const until =
    step === null
      ? HARNESS_BUILD_STEP_NAMES.length
      : HARNESS_BUILD_STEP_NAMES.indexOf(step.name) + 1;

  const steps = HARNESS_BUILD_STEP_NAMES.slice(0, until).map((name) => `${name} ${BUILD_COMMIT}`);

  return [
    ...steps,
    ...(step === null ? [`output ${BUILD_COMMIT}`] : []),
    `discard ${BUILD_COMMIT}`,
  ];
}

function expectedProblem({ step, output }: Scenario) {
  const harnessCommit = BUILD_COMMIT;

  if (step?.fault === "exit") {
    return { code: "build-step-failed", harnessCommit, step: step.name, exitCode: step.exitCode };
  }

  if (step !== null) return { code: "build-workspace-unavailable", harnessCommit };

  if (output === "refused") return { code: "build-workspace-unavailable", harnessCommit };

  if (output === "missing") return { code: "build-output-missing", harnessCommit };

  if (output === null) return null;

  const reason = output === "unparsable" ? "invalid-artifact" : "entry-module-not-found";

  return { code: "build-output-invalid", harnessCommit, reason };
}

test("a build runs its steps in order until one fails, discards the scratch tree once and last, and answers a plain result its cleanup never changes", () =>
  hegel.testAsync(async (tc) => {
    const scenario = tc.draw(scenarios);
    const { host, requests } = scripted(scenario);

    const result = await built(host);
    const problem = expectedProblem(scenario);

    expect(requests).toEqual(expectedRequests(scenario));

    if (problem === null) {
      expect(Result.isSuccess(result) && result.success.harnessCommit).toBe(BUILD_COMMIT);

      return;
    }

    if (Result.isSuccess(result)) throw new Error(`the build must fail with ${problem.code}`);

    expect(result.failure).toMatchObject(problem);
    expect(Object.getPrototypeOf(result.failure)).toBe(Object.prototype);
  }));
