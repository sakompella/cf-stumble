import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { HarnessArtifacts } from "../../../src/supervisor/artifacts/index.js";
import type { BuildWorkspaceHost } from "../../../src/supervisor/artifacts/index.js";

export function withArtifacts<T>(
  supervisorName: string,
  host: BuildWorkspaceHost,
  run: (artifacts: HarnessArtifacts) => Promise<T>,
): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(supervisorName), (_instance, state) =>
    run(new HarnessArtifacts(state.storage, () => host)),
  );
}
