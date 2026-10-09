import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import {
  PROJECT_PROVISION_STEP_NAMES,
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
import type { WorkspaceOperations } from "./executor.js";
import { asUntrusted, field, fieldsAreExactly, type UntrustedObject } from "./untrusted.js";

/**
 * What a caller may ask the workspace to provision: one project of the tenant's catalog and one
 * planned step. Command text has no field to arrive in.
 *
 * The project has to travel because one workspace holds every repository (ADR-0038): the workspace
 * is named after the tenant alone, so its name says nothing about which project a request means.
 * The catalog is the Supervisor's storage now, and the Workspace Host is a different Durable
 * Object that cannot read it, so the id no longer proves membership on this side. What this side
 * proves instead is that the pair is coherent: the id has to be the one
 * `projectIdForRepository` derives from the URL, so a request cannot clone one repository into
 * another project's directory. The directory itself still comes from `workspace-layout.ts`.
 */
export type ProjectProvisionRequest = Readonly<{
  kind: "provision-project";
  projectId: string;
  repositoryUrl: string;
  step: ProjectProvisionStepName;
}>;

/** A provision request whose project the catalog resolved. Only this form reaches a command. */
export type ParsedProjectProvisionRequest = Readonly<{
  kind: "provision-project";
  project: Project;
  step: ProjectProvisionStepName;
}>;

function invalidRequest(): WorkspaceFailure {
  return { ok: false, error: { code: "invalid-request" } };
}

/**
 * The project a request names, or nothing. The display name is the id: nothing this surface plans
 * shows a name to anybody, and a name that reached a command would be text the caller chose.
 */
function parsedProject(value: UntrustedObject): Project | undefined {
  const projectId = parseProjectId(field(value, "projectId"));
  const repositoryUrl = canonicalRepositoryUrl(field(value, "repositoryUrl"));

  if (
    projectId === undefined ||
    repositoryUrl === undefined ||
    projectIdForRepository(repositoryUrl) !== projectId
  ) {
    return undefined;
  }

  return { id: projectId, displayName: projectId, repositoryUrl };
}

/**
 * Parse the provision surface's whole RPC input.
 *
 * A malformed or incoherent project is an `invalid-request` rather than its own failure code. The
 * caller resolved the project against the tenant's catalog before it could derive this workspace's
 * name, so by the time a request arrives the project is already known to be one of the tenant's;
 * these checks exist to keep that true, not to explain a mistake to a caller that cannot make one.
 */
export function parseProjectProvisionRequest(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the provision surface's RPC boundary.
  value: unknown,
): ParsedProjectProvisionRequest | WorkspaceFailure {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC payload is untrusted.
  if (value === null || typeof value !== "object") return invalidRequest();
  const request = asUntrusted(value);

  if (field(request, "kind") !== "provision-project") return invalidRequest();

  if (!fieldsAreExactly(request, ["kind", "projectId", "repositoryUrl", "step"])) {
    return invalidRequest();
  }

  const project = parsedProject(request);

  if (project === undefined) return invalidRequest();

  const step = PROJECT_PROVISION_STEP_NAMES.find((name) => name === field(request, "step"));

  if (step === undefined) return { ok: false, error: { code: "unknown-command" } };

  return { kind: "provision-project", project, step };
}

/**
 * Decide the one operation a parsed provision request performs. Both the repository URL and the
 * directory come from the resolved catalog project, so the shell text is derived entirely from
 * server-side configuration.
 */
export function planProjectProvisionRequest(request: ParsedProjectProvisionRequest): WorkspacePlan {
  const step = projectProvisionStep(planProjectProvision(request.project), request.step);

  switch (step.name) {
    case "clone":
      return {
        kind: "run-command",
        source: step.source,
        cwd: step.cwd,
        timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
      };
    case "instructions":
      return { kind: "write-file", path: step.path, content: step.content };
    default: {
      const exhaustive: never = step;

      return exhaustive;
    }
  }
}

/** The `url` of `[remote "origin"]` in a Git config file, or nothing. */
export function originUrl(config: string): string | undefined {
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

/**
 * Whether the durable workspace store shows the markers of a clone that exited successfully: the
 * project root and its Git directory exist there, and the stored Git config names the catalog's
 * repository as `origin`. `WorkspaceOperations` reads the store, not the container, so a clone
 * whose post-command copy was lost entirely reads as absent here.
 *
 * The markers do not prove the stored repository is complete. Computer applies a copy in batches,
 * so an earlier incomplete copy can leave some objects or working-tree files in the store and not
 * others; this check cannot tell that from a whole clone.
 */
export async function cloneMarkersAreDurable(
  operations: WorkspaceOperations,
  project: Project,
): Promise<boolean> {
  const projectRoot = projectDirectory(project.id);
  const projectGitDir = projectGitDirectory(project.id);

  if ((await operations.lstat(projectRoot)) !== "directory") return false;

  if ((await operations.lstat(projectGitDir)) !== "directory") return false;

  if ((await operations.lstat(`${projectGitDir}/config`)) !== "file") return false;

  return originUrl(await operations.readFile(`${projectGitDir}/config`)) === project.repositoryUrl;
}
