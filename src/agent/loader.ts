/// <reference types="@cloudflare/workers-types" />

const fixtureHarnessCommit = "f53a0e1c1bdbe213ab700a84b1db23615cc24b0";
const fixtureLoaderName = `main-facet-${fixtureHarnessCommit}`;

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
    .get(fixtureLoaderName, () => ({
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
