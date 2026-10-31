import { invariant } from "./invariant.js";

export function tenantWorkspaceName(tenantKey: string): string {
  invariant(tenantKey.length > 0, "a tenant workspace name needs a server-derived tenant key");

  return `tenant:${tenantKey}`;
}
