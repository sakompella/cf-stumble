import * as Effect from "effect/Effect";
import {
  HARNESS_BUILD_CONFIGURATION,
  type HarnessBuildConfiguration,
  type HarnessBuildPhase,
  isHarnessBuildStep,
  type HarnessBuildStepName,
  type HarnessBuildStepRequest,
} from "../../harness-build.js";
import { parseHarnessCommit, type HarnessCommit } from "../../harness-commit.js";
import { invariant } from "../../invariant.js";
import { shellQuote } from "../../shell-quote.js";
import {
  HARNESS_BUILD_OUTPUT_DIRECTORY,
  harnessBuildOutputPath,
  WORKSPACE_ROOT,
} from "../../workspace-layout.js";
import type { CommandOutput, WorkspaceEffects, WorkspaceFault } from "../operations.js";
import {
  answerUnavailable,
  commandAnswer,
  executePlan,
  invalidRequest,
  type CommandAnswer,
  type ModuleMapAnswer,
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
  outputPath: string;
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
    source: [`cd ${shellQuote(directory)}`, phase.command].join("\n"),
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
    outputPath: harnessBuildOutputPath(harnessCommit),
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

type ParsedHarnessBuildStepRequest = Readonly<{
  harnessCommit: HarnessCommit;
  step: HarnessBuildStepName;
}>;

export function parseHarnessBuildStepRequest(
  request: HarnessBuildStepRequest,
): ParsedHarnessBuildStepRequest | WorkspaceFailure {
  const harnessCommit = parseHarnessCommit(request.harnessCommit);

  return harnessCommit === undefined || !isHarnessBuildStep(request.step)
    ? invalidRequest()
    : { harnessCommit, step: request.step };
}

function publishModuleMapSource(plan: HarnessBuildPlan): string {
  return [
    "set -eu",
    `path=${shellQuote(plan.moduleMapPath)}`,
    `output_directory=${shellQuote(HARNESS_BUILD_OUTPUT_DIRECTORY)}`,
    `output=${shellQuote(plan.outputPath)}`,
    'if [ -L "$path" ]; then',
    '  echo "the module map path is a symbolic link" >&2',
    "  exit 3",
    "fi",
    'mkdir -p -- "$output_directory"',
    'cp -- "$path" "$output"',
  ].join("\n");
}

export function planHarnessBuildStep(
  configuration: HarnessBuildConfiguration,
  request: ParsedHarnessBuildStepRequest,
): WorkspacePlan {
  const step = harnessBuildStep(
    planHarnessBuild(configuration, request.harnessCommit),
    request.step,
  );

  return {
    kind: "run-command",
    source: step.source,
    cwd: step.cwd,
    timeoutMs: configuration.stepTimeoutMs,
  };
}

export function planHarnessBuildDiscard(
  configuration: HarnessBuildConfiguration,
  harnessCommit: HarnessCommit,
): WorkspacePlan {
  const plan = planHarnessBuild(configuration, harnessCommit);

  return {
    kind: "run-command",
    source: `rm -rf -- ${shellQuote(plan.directory)} ${shellQuote(plan.outputPath)}`,
    cwd: WORKSPACE_ROOT,
    timeoutMs: configuration.stepTimeoutMs,
  };
}

type HarnessBuildInput<Request> = Readonly<{
  operations: WorkspaceEffects;
  configuration: HarnessBuildConfiguration;
  request: Request;
}>;

export function executeHarnessBuildStep(
  input: HarnessBuildInput<HarnessBuildStepRequest>,
): Effect.Effect<CommandAnswer> {
  const parsed = parseHarnessBuildStepRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  const { operations, configuration } = input;

  return Effect.suspend(() =>
    parsed.step === "provision"
      ? operations
          .provisionHarness(configuration, parsed.harnessCommit)
          .pipe(Effect.map(commandAnswer))
      : executePlan(operations, planHarnessBuildStep(configuration, parsed)),
  ).pipe(answerUnavailable("workspace.harness-build.build-step"));
}

export function executeHarnessBuildDiscard(
  input: HarnessBuildInput<string>,
): Effect.Effect<CommandAnswer> {
  const harnessCommit = parseHarnessCommit(input.request);

  if (harnessCommit === undefined) return Effect.succeed(invalidRequest());

  return Effect.suspend(() =>
    executePlan(input.operations, planHarnessBuildDiscard(input.configuration, harnessCommit)),
  ).pipe(answerUnavailable("workspace.harness-build.build-discard"));
}

export function executeHarnessBuildOutput(
  input: HarnessBuildInput<string>,
): Effect.Effect<ModuleMapAnswer> {
  const harnessCommit = parseHarnessCommit(input.request);

  if (harnessCommit === undefined) return Effect.succeed(invalidRequest());

  const { operations, configuration } = input;
  const outputPath = harnessBuildOutputPath(harnessCommit);

  return Effect.suspend(() =>
    operations
      .runCommand(
        publishModuleMapSource(planHarnessBuild(configuration, harnessCommit)),
        WORKSPACE_ROOT,
        configuration.stepTimeoutMs,
      )
      .pipe(
        Effect.flatMap((output): Effect.Effect<ModuleMapAnswer, WorkspaceFault> =>
          output.exitCode === 0
            ? operations.readFile(outputPath).pipe(
                Effect.map((moduleMap) => ({ ok: true, moduleMap }) as const),
                Effect.orElseSucceed(() => publishFailed(output)),
              )
            : Effect.succeed(publishFailed(output)),
        ),
      ),
  ).pipe(answerUnavailable("workspace.harness-build.build-output"));
}

function publishFailed(output: CommandOutput): ModuleMapAnswer {
  return { ok: false, error: { code: "publish-failed", output } };
}
