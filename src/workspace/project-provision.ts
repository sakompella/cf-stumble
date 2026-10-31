import * as Effect from "effect/Effect";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import {
  planProjectProvision,
  projectProvisionStep,
  type ProjectProvisionStepName,
} from "../project-provision.js";
import {
  canonicalRepositoryUrl,
  parseProjectId,
  projectIdForRepository,
  type Project,
} from "../project-catalog.js";
import { projectDirectory, projectGitDirectory } from "../workspace-layout.js";
import type { WorkspaceFailure, WorkspacePlan } from "./decisions.js";
import type { WorkspaceEffects, WorkspaceFault } from "./operations.js";

export type ProjectProvisionRequest = Readonly<{
  kind: "provision-project";
  projectId: string;
  repositoryUrl: string;
  step: ProjectProvisionStepName;
}>;

type ParsedProjectProvisionRequest = Readonly<{
  kind: "provision-project";
  project: Project;
  step: ProjectProvisionStepName;
}>;

function invalidRequest(): WorkspaceFailure {
  return { ok: false, error: { code: "invalid-request" } };
}

function parsedProject(request: ProjectProvisionRequest): Project | undefined {
  const projectId = parseProjectId(request.projectId);
  const repositoryUrl = canonicalRepositoryUrl(request.repositoryUrl);

  if (
    projectId === undefined ||
    repositoryUrl === undefined ||
    projectIdForRepository(repositoryUrl) !== projectId
  ) {
    return undefined;
  }

  return { id: projectId, displayName: projectId, repositoryUrl };
}

export function parseProjectProvisionRequest(
  request: ProjectProvisionRequest,
): ParsedProjectProvisionRequest | WorkspaceFailure {
  const project = parsedProject(request);

  if (project === undefined) return invalidRequest();

  return { kind: "provision-project", project, step: request.step };
}

export function planProjectProvisionRequest(request: ParsedProjectProvisionRequest): WorkspacePlan {
  const step = projectProvisionStep(planProjectProvision(request.project), request.step);

  return {
    kind: "run-command",
    source: step.source,
    cwd: step.cwd,
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
