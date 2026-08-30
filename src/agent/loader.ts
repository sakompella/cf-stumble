/// <reference types="@cloudflare/workers-types" />

const fixtureArtifactDigest = "f53a0e1c1bdbe213ab700a84b1db23615cc24b0f4dc216d8e12ad81ff75470af";
const fixtureMountKey = `main-facet-fixture-${fixtureArtifactDigest}`;

const fixtureMainFacetSource = `
import { DurableObject } from "cloudflare:workers";

export class MainFacet extends DurableObject {
  fetch(request) {
    if (new URL(request.url).pathname === "/facet/ping") {
      return new Response("pong");
    }

    return new Response("Not found", { status: 404 });
  }
}
`;

export function loadFixtureMainFacet(loader: WorkerLoader): DurableObjectClass {
  return loader
    .get(fixtureMountKey, () => ({
      compatibilityDate: "2025-01-01",
      mainModule: "main-facet.js",
      modules: {
        "main-facet.js": { js: fixtureMainFacetSource },
      },
      env: {},
      globalOutbound: null,
    }))
    .getDurableObjectClass("MainFacet");
}
