import * as Effect from "effect/Effect";
import { logEvent } from "../../diagnostics.js";
import {
  canonicalRepositoryUrl,
  parseProjectId,
  projectIdForRepository,
  type Project,
  type ProjectId,
} from "../../project-catalog.js";
import { shellQuote } from "../../shell-quote.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import {
  PROJECTS_DIRECTORY,
  projectDirectory,
  projectGitDirectory,
} from "../../workspace-layout.js";
import {
  durableGitHubConfigurationSource,
  REPOSITORY_SIZE_VERDICT_FUNCTION,
  repositorySizeVerdictSource,
} from "../../github/index.js";
import {
  runPlannedCommand,
  WorkspaceUnavailable,
  type WorkspaceEffects,
  type WorkspaceFault,
} from "../operations.js";
import { CLONE_INTO_STAGING, reconcileClone } from "./clone-script.js";
import {
  answerDurableFailures,
  commandResult,
  invalidRequest,
  syncIncomplete,
  timeoutOrUnavailable,
  type WorkspaceCommandResult,
  type WorkspaceFailure,
  type WorkspacePlan,
} from "./command-result.js";

export const PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE = 122;

export function projectProvisionLockPath(projectId: ProjectId): string {
  return `/tmp/cf-stumble-project-${projectId}.provision.lock`;
}

export type ProjectProvisionRequest = Readonly<{
  kind: "provision-project";
  projectId: string;
  repositoryUrl: string;
}>;

export function parseProjectProvisionRequest(
  request: ProjectProvisionRequest,
): Project | WorkspaceFailure {
  const projectId = parseProjectId(request.projectId);
  const repositoryUrl = canonicalRepositoryUrl(request.repositoryUrl);

  if (
    projectId === undefined ||
    repositoryUrl === undefined ||
    projectIdForRepository(repositoryUrl) !== projectId
  ) {
    return invalidRequest();
  }

  return { id: projectId, displayName: projectId, repositoryUrl };
}

export function planProjectProvisionRequest(project: Project): WorkspacePlan {
  return {
    kind: "run-command",
    source: projectCloneSource(project),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
  };
}

function originUrl(config: string): string | undefined {
  let inOrigin = false;

  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed.startsWith("[")) {
      inOrigin = trimmed === '[remote "origin"]';
      continue;
    }

    const url = /^url\s*=\s*(.*)$/u.exec(trimmed)?.[1];

    if (inOrigin && url !== undefined) return url;
  }

  return undefined;
}

export function cloneMarkersAreDurable(
  operations: WorkspaceEffects,
  project: Project,
): Effect.Effect<boolean, WorkspaceFault> {
  const projectRoot = projectDirectory(project.id);
  const projectGitDir = projectGitDirectory(project.id);

  return Effect.gen(function* () {
    if ((yield* operations.lstat(projectRoot)) !== "directory") return false;

    if ((yield* operations.lstat(projectGitDir)) !== "directory") return false;

    if ((yield* operations.lstat(`${projectGitDir}/config`)) !== "file") return false;

    const config = yield* operations.readFile(`${projectGitDir}/config`);

    return originUrl(config) === project.repositoryUrl;
  });
}

export function projectCloneSource(project: Project): string {
  const { repositoryUrl } = project;
  const root = projectDirectory(project.id);

  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    `projects=${shellQuote(PROJECTS_DIRECTORY)}`,
    `lock=${shellQuote(projectProvisionLockPath(project.id))}`,
    `repository=${shellQuote(root)}`,
    `git_dir=${shellQuote(projectGitDirectory(project.id))}`,
    `staging=${shellQuote(`${root}.provisioning`)}`,
    `expected_remote=${shellQuote(repositoryUrl)}`,
    repositorySizeVerdictSource(repositoryUrl),
    'mkdir -p "$projects"',
    ...reconcileClone({
      beforeClone: [
        `  size_verdict="$(${REPOSITORY_SIZE_VERDICT_FUNCTION})"`,
        '  case "$size_verdict" in',
        "    tree-truncated | too-many-files | working-tree-too-large | repository-too-large)",
        '      printf "repository exceeds a workspace size limit: %s\\n" "$size_verdict" >&2',
        `      exit ${PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE}`,
        "      ;;",
        "  esac",
      ],
      cloneIntoStaging: [
        `  if clone_output="$(${CLONE_INTO_STAGING} 2>&1)"; then`,
        "    :",
        "  else",
        "    clone_exit=$?",
        `    if printf '%s\\n' "$clone_output" | grep -Eiq 'no space left on device|disk quota exceeded|not enough space'; then`,
        '      printf "repository clone exceeded workspace capacity\\n" >&2',
        `      exit ${PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE}`,
        "    fi",
        '    printf "%s\\n" "$clone_output" >&2',
        '    exit "$clone_exit"',
        "  fi",
      ],
    }),
  ].join("\n");
}

function isolateCloned(
  operations: WorkspaceEffects,
  project: Project,
  clone: (project: Project) => Effect.Effect<void, WorkspaceFault>,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (yield* cloneMarkersAreDurable(operations, project)) return true;

    yield* clone(project);

    const durable = yield* cloneMarkersAreDurable(operations, project);

    if (!durable) logCloneFallback("the clone ran but its markers are missing");

    return durable;
  }).pipe(
    Effect.catch((fault) =>
      Effect.sync(() => {
        logCloneFallback(faultReason(fault));

        return false;
      }),
    ),
  );
}

function logCloneFallback(reason: string): void {
  logEvent("warn", "workspace.isolate-clone.fell-back", { reason });
}

function faultReason(fault: WorkspaceFault): string {
  const cause = fault instanceof WorkspaceUnavailable ? fault.cause : fault;

  return cause instanceof Error ? cause.message : String(cause);
}

export function executeProjectProvisionRequest(
  input: Readonly<{
    operations: WorkspaceEffects;
    request: ProjectProvisionRequest;
  }>,
): Effect.Effect<WorkspaceCommandResult> {
  const parsed = parseProjectProvisionRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.gen(function* () {
    const { operations } = input;
    const { cloneProject } = operations;

    if (
      cloneProject !== undefined &&
      (yield* isolateCloned(operations, parsed, (project) =>
        cloneProject.call(operations, project),
      ))
    ) {
      return {
        ok: true,
        result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
      } as const;
    }

    const output = yield* runPlannedCommand(operations, planProjectProvisionRequest(parsed));

    if (output.exitCode === 0 && !(yield* cloneMarkersAreDurable(operations, parsed))) {
      return syncIncomplete();
    }

    return commandResult(output);
  }).pipe(answerDurableFailures("workspace.provision-project.clone", timeoutOrUnavailable));
}
