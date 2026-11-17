import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { Model, Project } from "./model.js";

export function selectedRepository(
  model: Pick<Model, "projects" | "maybeProjectId">,
): Option.Option<Project> {
  return Array.findFirst(
    model.projects,
    (project) => !project.isHarness && Option.contains(model.maybeProjectId, project.id),
  );
}
