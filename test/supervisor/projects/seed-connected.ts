import { ConnectedProjects } from "../../../src/supervisor/projects/connected-projects.js";
import { sampleCatalog } from "../../project-fixtures.js";
import { LifecycleEvent } from "../../../src/supervisor/projects/project-lifecycle-machine.js";

export function seedConnected(
  projects: ConnectedProjects,
  input: Readonly<{ repositoryUrl: string; displayName?: string }>,
  now: number,
) {
  const connected = projects.connect(input, now);

  if (!connected.ok) return connected;

  projects.apply(connected.project.id, LifecycleEvent.cases.provisioned.make({}));

  return {
    ok: true,
    project: connected.project,
    alreadyConnected: connected.before === "connected",
  } as const;
}

export function seedDisconnected(projects: ConnectedProjects, projectId: string): void {
  const connected = projects.catalog().find((project) => project.id === projectId);

  if (connected === undefined) return;

  projects.apply(connected.id, LifecycleEvent.cases.disconnect.make({}));
  projects.apply(connected.id, LifecycleEvent.cases.removed.make({}));
}

export function seedSampleProjects(storage: DurableObjectStorage): void {
  const projects = new ConnectedProjects(storage);

  for (const project of sampleCatalog) {
    seedConnected(
      projects,
      { repositoryUrl: project.repositoryUrl, displayName: project.displayName },
      0,
    );
  }
}
