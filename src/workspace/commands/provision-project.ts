import * as Effect from "effect/Effect";
import {
  canonicalRepositoryUrl,
  parseProjectId,
  projectIdForRepository,
  type Project,
  type ProjectId,
} from "../../project-catalog.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import { projectDirectory, projectGitDirectory } from "../../workspace-layout.js";
import type { CommandOutput, WorkspaceEffects, WorkspaceFault } from "../operations.js";
import {
  cloneRepositorySource,
  CLONE_SIZE_FAILURE_EXIT_CODE,
  MEASURED_SIZE_VERDICTS,
} from "../clone-script.js";
import {
  answerDurableFailures,
  invalidRequest,
  syncIncomplete,
  timeoutOrUnavailable,
  type WorkspaceFailure,
  type WorkspacePlan,
} from "./command-result.js";

export const CLONE_SIZE_VERDICTS = [...MEASURED_SIZE_VERDICTS, "capacity-exceeded"] as const;

export type CloneSizeVerdict = (typeof CLONE_SIZE_VERDICTS)[number];

export type ProjectProvisionAnswer =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      error: Readonly<
        | { code: "repository-too-large"; verdict: CloneSizeVerdict }
        | { code: "clone-failed"; exitCode: number }
      >;
    }>
  | WorkspaceFailure;

const SIZE_VERDICT_LINE = /^size-verdict=(\S+)$/mu;

function cloneAnswer(output: CommandOutput): ProjectProvisionAnswer {
  if (output.exitCode === 0) return { ok: true };

  const reported = SIZE_VERDICT_LINE.exec(output.stdout)?.[1];
  const verdict = CLONE_SIZE_VERDICTS.find((known) => known === reported);

  return output.exitCode === CLONE_SIZE_FAILURE_EXIT_CODE && verdict !== undefined
    ? { ok: false, error: { code: "repository-too-large", verdict } }
    : { ok: false, error: { code: "clone-failed", exitCode: output.exitCode } };
}

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

function planProjectProvisionRequest(project: Project): WorkspacePlan {
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

function cloneMarkersAreDurable(
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
  return cloneRepositorySource({
    remote: project.repositoryUrl,
    root: projectDirectory(project.id),
    gitDir: projectGitDirectory(project.id),
    lock: projectProvisionLockPath(project.id),
  });
}

export function executeProjectProvisionRequest(
  input: Readonly<{
    operations: WorkspaceEffects;
    request: ProjectProvisionRequest;
  }>,
): Effect.Effect<ProjectProvisionAnswer> {
  const parsed = parseProjectProvisionRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.gen(function* () {
    const { operations } = input;

    if (yield* cloneMarkersAreDurable(operations, parsed)) return { ok: true } as const;

    const plan = planProjectProvisionRequest(parsed);

    const output = yield* operations.runCommand(plan.source, plan.cwd, plan.timeoutMs);

    if (output.exitCode === 0 && !(yield* cloneMarkersAreDurable(operations, parsed))) {
      return syncIncomplete();
    }

    return cloneAnswer(output);
  }).pipe(answerDurableFailures("workspace.provision-project.clone", timeoutOrUnavailable));
}
