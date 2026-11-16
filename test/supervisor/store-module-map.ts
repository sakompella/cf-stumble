import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import type { MainHarnessArtifactInput } from "../../src/facet/artifact.js";
import { ModuleMapStore } from "../../src/supervisor/artifacts/index.js";
import { parsedArtifact } from "../facet/fixture.js";

export async function storeModuleMap(input: MainHarnessArtifactInput): Promise<void> {
  await Effect.runPromise(new ModuleMapStore(env.MODULE_MAPS).write(parsedArtifact(input)));
}
