import * as Effect from "effect/Effect";
import {
  HARNESS_BUILD_CONFIGURATION,
  type HarnessBuildConfiguration,
  type HarnessBuildPhase,
  type HarnessBuildRequest,
  type HarnessBuildStepName,
} from "../../harness-build.js";
import { parseHarnessCommit, type HarnessCommit } from "../../harness-commit.js";
import { invariant } from "../../invariant.js";
import { shellQuote } from "../../shell-quote.js";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import type { WorkspaceEffects } from "../operations.js";
import {
  answerUnavailable,
  commandResult,
  executePlan,
  invalidRequest,
  type WorkspaceCommandResult,
  type WorkspaceFailure,
  type WorkspacePlan,
} from "./command-result.js";

export function harnessBuildConfiguration(
  repositoryUrl: string | undefined,
): HarnessBuildConfiguration {
  const trimmed = repositoryUrl?.trim();

  return trimmed === undefined || trimmed.length === 0
    ? HARNESS_BUILD_CONFIGURATION
    : { ...HARNESS_BUILD_CONFIGURATION, harnessGitRemote: trimmed };
}

export type HarnessBuildStep = Readonly<{
  name: HarnessBuildStepName;
  source: string;
  cwd: string;
}>;

export type HarnessBuildPlan = Readonly<{
  directory: string;
  steps: readonly HarnessBuildStep[];
  moduleMapPath: string;
}>;

function checkoutSource(
  configuration: HarnessBuildConfiguration,
  directory: string,
  harnessCommit: HarnessCommit,
): string {
  return [
    "set -eu",
    `archive=${directory}/.harness-archive.tar`,
    `git --git-dir=${configuration.harnessGitDir} archive --format=tar -o "$archive" ${harnessCommit}`,
    `tar -x -m --no-same-owner --no-same-permissions -C ${directory} -f "$archive"`,
    'rm -f "$archive"',
  ].join("\n");
}

function phaseStep(directory: string, phase: HarnessBuildPhase): HarnessBuildStep {
  return {
    name: phase.name,
    source: [
      "set -o pipefail",
      `cd ${shellQuote(directory)}`,
      `${phase.command} 2>&1 | tail -c 4000`,
    ].join("\n"),
    cwd: WORKSPACE_ROOT,
  };
}

export function planHarnessBuild(
  configuration: HarnessBuildConfiguration,
  harnessCommit: HarnessCommit,
): HarnessBuildPlan {
  const directory = `${configuration.buildRoot}/${harnessCommit}`;
  invariant(
    !`${configuration.harnessRepositoryRoot}/`.startsWith(`${directory}/`),
    "build scratch must never contain the harness checkout",
  );

  return {
    directory,
    steps: [
      {
        name: "isolate",
        source: `mkdir -p ${configuration.buildRoot} && rm -rf ${directory} && mkdir -p ${directory}`,
        cwd: WORKSPACE_ROOT,
      },
      {
        name: "checkout",
        source: checkoutSource(configuration, directory, harnessCommit),
        cwd: WORKSPACE_ROOT,
      },
      ...configuration.buildPhases.map((phase) => phaseStep(directory, phase)),
    ],
    moduleMapPath: `${directory}/${configuration.moduleMapPath}`,
  };
}

export function harnessBuildStep(
  plan: HarnessBuildPlan,
  name: HarnessBuildStepName,
): HarnessBuildStep {
  const step = plan.steps.find((planned) => planned.name === name);
  invariant(step !== undefined, `the build plan must contain its own ${name} step`);

  return step;
}

type ParsedHarnessBuildRequest =
  | Readonly<{ kind: "build-step"; harnessCommit: HarnessCommit; step: HarnessBuildStepName }>
  | Readonly<{ kind: "build-output" | "build-discard"; harnessCommit: HarnessCommit }>;

export function parseHarnessBuildRequest(
  request: HarnessBuildRequest,
): ParsedHarnessBuildRequest | WorkspaceFailure {
  const harnessCommit = parseHarnessCommit(request.harnessCommit);

  if (harnessCommit === undefined) return invalidRequest();

  return request.kind === "build-step"
    ? { kind: "build-step", harnessCommit, step: request.step }
    : { kind: request.kind, harnessCommit };
}

function readModuleMapSource(plan: HarnessBuildPlan): string {
  return [
    "set -eu",
    `path=${shellQuote(plan.moduleMapPath)}`,
    'if [ -L "$path" ]; then',
    '  echo "the module map path is a symbolic link" >&2',
    "  exit 3",
    "fi",
    'cat -- "$path"',
  ].join("\n");
}

export function planHarnessBuildRequest(
  configuration: HarnessBuildConfiguration,
  request: ParsedHarnessBuildRequest,
): WorkspacePlan {
  const plan = planHarnessBuild(configuration, request.harnessCommit);

  if (request.kind !== "build-step") {
    return {
      kind: "run-command",
      source:
        request.kind === "build-output"
          ? readModuleMapSource(plan)
          : `rm -rf -- ${shellQuote(plan.directory)}`,
      cwd: WORKSPACE_ROOT,
      timeoutMs: configuration.stepTimeoutMs,
    };
  }

  const step = harnessBuildStep(plan, request.step);

  return {
    kind: "run-command",
    source: step.source,
    cwd: step.cwd,
    timeoutMs: configuration.stepTimeoutMs,
  };
}

export function executeHarnessBuildRequest(
  input: Readonly<{
    operations: WorkspaceEffects;
    configuration: HarnessBuildConfiguration;
    request: HarnessBuildRequest;
  }>,
): Effect.Effect<WorkspaceCommandResult> {
  const parsed = parseHarnessBuildRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  const { operations, configuration } = input;

  return Effect.suspend(() =>
    parsed.kind === "build-step" && parsed.step === "provision"
      ? operations
          .provisionHarness(configuration, parsed.harnessCommit)
          .pipe(Effect.map(commandResult))
      : executePlan(operations, planHarnessBuildRequest(configuration, parsed)),
  ).pipe(answerUnavailable(`workspace.harness-build.${parsed.kind}`));
}
