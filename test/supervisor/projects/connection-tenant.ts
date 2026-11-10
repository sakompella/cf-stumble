import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import type {
  GitHubConnection,
  ProjectConnections,
} from "../../../src/supervisor/projects/index.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import { tenantConnections, type TenantConnections } from "./tenant-connections.js";
import type { ProjectId } from "../../../src/project-catalog.js";

export const noRunActive = <Marked>(_projectId: ProjectId, mark: () => Marked) =>
  Effect.sync(() => ({ marked: mark() }));

export const NOW = 1_700_000_000_000;

export const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

export const REPOSITORY = "https://github.com/sample/repo-1";

export interface Tenant {
  readonly workspace: FakeTenantWorkspace;
  connections<T>(use: (connections: ProjectConnections) => Effect.Effect<T>): Promise<T>;
  github<T>(use: (github: GitHubConnection) => Effect.Effect<T>): Promise<T>;
}

export function tenant(
  name: string,
  options: Readonly<{
    workspace?: FakeTenantWorkspace;
    fallbackToken?: string;
  }> = {},
): Tenant {
  const workspace = options.workspace ?? new FakeTenantWorkspace();

  const inTenant = <T>(use: (built: TenantConnections) => Effect.Effect<T>): Promise<T> =>
    runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
      Effect.runPromise(
        use(
          tenantConnections(state.storage, name, workspace, {
            clientId: undefined,
            fallbackToken: options.fallbackToken,
            fetcher: () => Promise.resolve(Response.json({})),
          }),
        ),
      ),
    );

  return {
    workspace,
    connections: (use) => inTenant((built) => use(built.connections)),
    github: (use) => inTenant((built) => use(built.github)),
  };
}
