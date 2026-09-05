import {
  PROJECT_PROVISION_STEP_NAMES,
  planProjectProvision,
  projectProvisionConfiguration,
  projectProvisionStep,
  type ProjectProvisionStepName,
} from "../project-provision.js";
import { resolveProject, type Project, type ProjectCatalog } from "../project-catalog.js";
import type { WorkspaceFailure, WorkspacePlan } from "./decisions.js";
import { asUntrusted, field, fieldsAreExactly, type UntrustedObject } from "./untrusted.js";

/**
 * What a caller may ask the workspace to provision. It names a catalog project and one planned
 * step, so neither command text nor a repository URL has a field to arrive in.
 *
 * The project id has to travel because one workspace holds every repository (ADR-0038): the
 * workspace is named after the tenant alone, so its name says nothing about which project a
 * request means. The host receives the id and checks it against the catalog itself, and the
 * directory that id provisions comes from `workspace-layout.ts` rather than from the request.
 */
export type ProjectProvisionRequest = Readonly<{
  kind: "provision-project";
  projectId: string;
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

function parsedProject(
  value: UntrustedObject,
  catalog: ProjectCatalog | undefined,
): Project | undefined {
  const resolution = resolveProject(field(value, "projectId"), catalog);
  return resolution.ok ? resolution.project : undefined;
}

/**
 * Parse the provision surface's whole RPC input.
 *
 * An id the catalog does not resolve is an `invalid-request` rather than its own failure code. The
 * caller resolves the same id against the same catalog before it can derive this workspace's name,
 * so by the time a request arrives the id is already known to be good; this check exists to keep
 * that true, not to explain a mistake to a caller that cannot make one.
 */
export function parseProjectProvisionRequest(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the provision surface's RPC boundary.
  value: unknown,
  catalog?: ProjectCatalog,
): ParsedProjectProvisionRequest | WorkspaceFailure {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC payload is untrusted.
  if (value === null || typeof value !== "object") return invalidRequest();
  const request = asUntrusted(value);
  if (field(request, "kind") !== "provision-project") return invalidRequest();
  if (!fieldsAreExactly(request, ["kind", "projectId", "step"])) return invalidRequest();

  const project = parsedProject(request, catalog);
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
  const step = projectProvisionStep(
    planProjectProvision(projectProvisionConfiguration(request.project.id), request.project),
    request.step,
  );
  switch (step.name) {
    case "clone":
      return { kind: "run-command", source: step.source, cwd: step.cwd };
    case "instructions":
      return { kind: "write-file", path: step.path, content: step.content };
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}
