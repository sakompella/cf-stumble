import * as Result from "effect/Result";
import { MainHarnessArtifact } from "../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../src/facet/index.js";
import { PI_DURABLE_VERSION } from "../../src/pi-durable-version.js";

export function parsedArtifact(input: MainHarnessArtifactInput): MainHarnessArtifact {
  const parsed = MainHarnessArtifact.parse(input);

  if (Result.isFailure(parsed)) {
    throw new Error(`a test artifact must parse: ${parsed.failure.code}`);
  }

  return parsed.success;
}

export const PI_DURABLE_VERSION_METHOD = `piDurableVersion() { return ${JSON.stringify(PI_DURABLE_VERSION)}; }`;

export function servingFacetSource(
  served: string,
  versionMethod = PI_DURABLE_VERSION_METHOD,
): string {
  return `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  ${versionMethod}
  async attach() {}
  async createConversation(cwd) { return "conversation:" + cwd; }
  async events() { return new Response(${JSON.stringify(served)}).body; }
}
`;
}

export const fixtureMainHarnessCommit = "f53a0e1c1bdbe213ab700a84b1db23615cc24b02";

export const fixtureMainHarnessArtifact: MainHarnessArtifactInput = {
  harnessCommit: fixtureMainHarnessCommit,
  entryModule: "main-facet.js",
  modules: [{ name: "main-facet.js", source: servingFacetSource(fixtureMainHarnessCommit) }],
};
