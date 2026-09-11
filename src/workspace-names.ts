import { invariant } from "./invariant.js";

/**
 * The name of the one Computer workspace a tenant owns (ADR-0038).
 *
 * There is exactly one workspace per tenant, and the harness repository and every connected
 * project repository are directories inside it, so the name depends on the tenant and on nothing
 * else. It carries no project id, because a project is a directory rather than a container, and
 * there is no separate global build workspace, because a build is a directory too.
 *
 * The tenant key is the Supervisor's own server-derived name. That name is a SHA-256 of the
 * verified Access identity and audience (`access/verification.ts`), the Worker addresses the
 * Supervisor by it, and a browser therefore cannot present one: it presents a token, and the
 * Worker turns a verified token into that name. Deriving the workspace name from the Supervisor's
 * name rather than hashing identity and audience a second time also means the two cannot drift
 * apart into two different opinions of who the tenant is.
 */
export function tenantWorkspaceName(tenantKey: string): string {
  invariant(tenantKey.length > 0, "a tenant workspace name needs a server-derived tenant key");

  return `tenant:${tenantKey}`;
}
