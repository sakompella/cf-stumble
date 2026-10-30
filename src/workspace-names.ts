import { invariant } from "./invariant.js";

/**
 * The name of the one Computer workspace a tenant owns (ADR-0038).
 *
 * There is exactly one workspace per tenant, and the harness repository and every connected
 * project repository are directories inside it, so the name depends on the tenant and on nothing
 * else. It carries no project id, because a project is a directory rather than a container, and
 * there is no separate global build workspace, because a build is a directory too.
 *
 * The tenant key is the Supervisor's own name, which the Worker addresses it by.
 */
export function tenantWorkspaceName(tenantKey: string): string {
  invariant(tenantKey.length > 0, "a tenant workspace name needs a server-derived tenant key");

  return `tenant:${tenantKey}`;
}
