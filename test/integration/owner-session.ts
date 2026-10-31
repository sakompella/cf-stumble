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

export function stubExternalBoundaries<Workspace extends FakeTenantWorkspace>(
  workspace: Workspace,
): Workspace {
  // SAFETY: the fake implements every Workspace Host RPC that the test drives.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const host = workspace as unknown as ReturnType<typeof env.WORKSPACE_HOST.getByName>;
  vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(host);
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
