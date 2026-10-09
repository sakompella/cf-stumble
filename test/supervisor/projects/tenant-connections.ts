/// <reference types="@cloudflare/vitest-plugin/types" />

import {
  GitHubConnection,
  GitHubConnectionStore,
  ProjectConnections,
  type GitHubConnectionEnvironment,
} from "../../../src/supervisor/projects/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import type { FakeTenantWorkspace } from "./fake-tenant-workspace.js";

export type TenantConnections = Readonly<{
  github: GitHubConnection;
  connections: ProjectConnections;
}>;

/** The GitHub connection and the project connections, wired as one Supervisor wires them. */
export function tenantConnections(
  storage: DurableObjectStorage,
  name: string,
  workspace: FakeTenantWorkspace,
  environment: GitHubConnectionEnvironment,
): TenantConnections {
  const workspaceName = tenantWorkspaceName(name);

  const github = new GitHubConnection({
    store: new GitHubConnectionStore(storage),
    workspaceName,
    namespace: workspace.namespace,
    environment,
  });

  return {
    github,
    connections: new ProjectConnections({
      storage,
      workspaceName,
      namespace: workspace.namespace,
      environment,
      github,
    }),
  };
}
