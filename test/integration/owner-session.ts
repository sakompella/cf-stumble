import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../../src/worker.js";
import type { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import {
  activateGeneration,
  artifact,
  prepareWithModuleMap,
  submitCandidate,
} from "../supervisor/helpers.js";

/**
 * The owner as the Worker sees them. Integration tests send every request through `worker.fetch`,
 * so routing runs as in a deployment.
 */

const ORIGIN = "https://cf-stumble.test";

export function ownerSession() {
  const get = (path: string) => worker.fetch(new Request(`${ORIGIN}${path}`), env);

  const post = (path: string, body: Readonly<Record<string, string>> = {}) =>
    worker.fetch(
      new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) }),
      env,
    );

  return { get, post, supervisor: env.SUPERVISOR.getByName("owner") };
}

/**
 * Route the Supervisor's `WORKSPACE_HOST` lookups to the fake, and GitHub's REST API nowhere. The
 * test's `afterEach` must call `vi.restoreAllMocks()`.
 */
export function stubExternalBoundaries<Workspace extends FakeTenantWorkspace>(
  workspace: Workspace,
): Workspace {
  // SAFETY: the fake implements every Workspace Host RPC that the test drives.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const host = workspace as unknown as ReturnType<typeof env.WORKSPACE_HOST.getByName>;
  vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(host);
  // No size metadata, so the size guard fails open, as it does when GitHub cannot be reached.
  // A fresh Response per call, because a body can be read only once.
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response("{}", { status: 404 })),
  );

  return workspace;
}

const SCRIPTED_HARNESS_COMMIT = "c0ffee0000000000000000000000000000000001";

/** Prepare and activate a generation whose whole main facet module is `source`. */
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
