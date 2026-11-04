import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../../src/worker.js";
import { ownerRequest } from "../owner-credentials.js";
import type { SupervisorWorkspaceHost } from "../../src/supervisor/supervisor-env.js";
import type { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import { replaceWorkspaceHost } from "../workspace-host-spy.js";
import {
  activateGeneration,
  artifact,
  prepareWithModuleMap,
  submitCandidate,
} from "../supervisor/helpers.js";

const ORIGIN = "https://cf-stumble.test";

const get = (path: string) => worker.fetch(ownerRequest(`${ORIGIN}${path}`), env);

const post = (path: string, body: Readonly<Record<string, string>> = {}) =>
  worker.fetch(
    ownerRequest(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) }),
    env,
  );

export function ownerSession() {
  return { get, post, supervisor: env.SUPERVISOR.getByName("owner") };
}

export function stubExternalBoundaries<Workspace extends FakeTenantWorkspace>(
  workspace: Workspace,
): Workspace {
  replaceWorkspaceHost<Omit<SupervisorWorkspaceHost, "project" | "reset">>(
    env.WORKSPACE_HOST,
    workspace,
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response("{}", { status: 404 })),
  );

  return workspace;
}

const SCRIPTED_HARNESS_COMMIT = "c0ffee0000000000000000000000000000000001";

export async function servingScriptedGeneration(
  owner: ReturnType<typeof ownerSession>,
  source: string,
): Promise<void> {
  const label = await submitCandidate(owner.supervisor, SCRIPTED_HARNESS_COMMIT);

  const checked = await prepareWithModuleMap(
    owner.supervisor,
    label,
    artifact(SCRIPTED_HARNESS_COMMIT, source),
  );

  if (!checked.ok || checked.report.stage !== "ready") {
    throw new Error("the scripted generation must pass its startup check");
  }

  await activateGeneration(owner.supervisor, label);
}
