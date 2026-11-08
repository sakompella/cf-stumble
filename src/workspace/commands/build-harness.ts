import * as Effect from "effect/Effect";
import { durableGitHubConfigurationSource } from "../../github/index.js";
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
import { reconcileClone } from "./clone-script.js";
import {
  answerUnavailable,
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
  steps: readonly [HarnessBuildStep, ...HarnessBuildStep[]];
  moduleMapPath: string;
}>;

export const HARNESS_PROVISION_LOCK = "/tmp/cf-stumble-harness-provision.lock";

function obtainHarnessCommit(): readonly string[] {
  return [
    'if ! git --git-dir="$git_dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then',
    '  git --git-dir="$git_dir" fetch --no-tags --quiet origin "$commit" 2>/dev/null ||',
    '    git --git-dir="$git_dir" fetch --no-tags --quiet origin ||',
    "    true",
    '  if ! git --git-dir="$git_dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then',
    '    printf "harness commit %s is not in %s\\n" "$commit" "$expected_remote" >&2',
    "    exit 1",
    "  fi",
    "fi",
  ];
}

function advanceCheckout(): readonly string[] {
  return [
    'if test -n "$(git -C "$repository" status --porcelain --untracked-files=no)"; then',
    '  printf "harness checkout has local changes; left at %s\\n" "$(git -C "$repository" rev-parse --short HEAD)" >&2',
    'elif ! git -C "$repository" fetch --no-tags --quiet origin; then',
    '  printf "harness checkout not updated: fetch failed\\n" >&2',
    'elif ! git -C "$repository" merge --ff-only --quiet "@{upstream}"; then',
    '  printf "harness checkout not updated: cannot fast-forward from %s\\n" "$(git -C "$repository" rev-parse --short HEAD)" >&2',
    "fi",
  ];
}

export function provisionHarnessRepository(
  configuration: HarnessBuildConfiguration,
  harnessCommit: HarnessCommit,
): string {
  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    `mkdir -p ${shellQuote(WORKSPACE_ROOT)}`,
    `lock=${shellQuote(HARNESS_PROVISION_LOCK)}`,
    `repository=${shellQuote(configuration.harnessRepositoryRoot)}`,
    `git_dir=${shellQuote(configuration.harnessGitDir)}`,
    `staging=${shellQuote(`${configuration.harnessRepositoryRoot}.provisioning`)}`,
    `expected_remote=${shellQuote(configuration.harnessGitRemote)}`,
    `commit=${shellQuote(harnessCommit)}`,
    ...reconcileClone(),
    ...obtainHarnessCommit(),
    ...advanceCheckout(),
  ].join("\n");
}

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
        name: "provision",
        source: provisionHarnessRepository(configuration, harnessCommit),
        cwd: WORKSPACE_ROOT,
      },
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

  return Effect.suspend(() =>
    executePlan(input.operations, planHarnessBuildRequest(input.configuration, parsed)),
  ).pipe(answerUnavailable(`workspace.harness-build.${parsed.kind}`));
}
