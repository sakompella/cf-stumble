import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import type {
  GitHubConnection,
  ProjectConnections,
} from "../../../src/supervisor/projects/index.js";
import { FakeTenantWorkspace } from "./fake-tenant-workspace.js";
import { tenantConnections, type TenantConnections } from "./tenant-connections.js";
import type { GitHubFetch } from "../../../src/github/index.js";

export const NOW = 1_700_000_000_000;

export const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

export const CLIENT_ID = "Iv1.cfstumbleFAKE";

export const REPOSITORY = "https://github.com/sample/repo-1";

type Reply =
  | Readonly<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>
  | Readonly<{ size: number; default_branch: string }>
  | Readonly<{ truncated: boolean; tree: readonly Readonly<{ type: string; size: number }>[] }>
  | Readonly<{ message: string }>;

function githubReplying(replies: readonly Reply[]): GitHubFetch {
  let index = 0;

  return () => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;

    return Promise.resolve(Response.json(reply));
  };
}

export const deviceReply = {
  device_code: "device-code-secret",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
} satisfies Reply;

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
    clientId?: string;
    replies?: readonly Reply[];
  }> = {},
): Tenant {
  const workspace = options.workspace ?? new FakeTenantWorkspace();

  const inTenant = <T>(use: (built: TenantConnections) => Effect.Effect<T>): Promise<T> =>
    runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
      Effect.runPromise(
        use(
          tenantConnections(state.storage, name, workspace, {
            clientId: options.clientId ?? CLIENT_ID,
            fallbackToken: options.fallbackToken,
            fetcher: githubReplying(options.replies ?? [deviceReply]),
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
