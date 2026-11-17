import * as Effect from "effect/Effect";
import { resolveProject as resolveCatalogProject } from "../../project-catalog.js";
import type { SelectableCatalog } from "../../selectable-projects.js";
import type { SelectableProject } from "../../selectable-projects.js";
import { selectedWorkingDirectory } from "../../workspace-layout.js";
import type { MountedFacet } from "../artifacts/index.js";
import { fail, type ConversationProblem } from "./conversation-result.js";

export type { SelectableCatalog, SelectableProject };

export function resolveProject(
  projectId: string,
  catalog: SelectableCatalog,
): Effect.Effect<SelectableProject, ConversationProblem> {
  const resolved = resolveCatalogProject(projectId, catalog);

  return resolved.ok ? Effect.succeed(resolved.project) : fail(resolved.reason);
}

export function createConversation(
  facet: MountedFacet,
  project: SelectableProject,
): Promise<string> {
  return facet.createConversation(selectedWorkingDirectory(project));
}
