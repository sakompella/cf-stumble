import type { MainHarnessArtifactInput } from "./artifact.js";

export const fixtureMainHarnessCommit = "f53a0e1c1bdbe213ab700a84b1db23615cc24b00";

export const fixtureMainHarnessArtifact: MainHarnessArtifactInput = {
  harnessCommit: fixtureMainHarnessCommit,
  entryModule: "main-facet.js",
  modules: [
    {
      name: "main-facet.js",
      source: `
import { DurableObject } from "cloudflare:workers";
import { pingResponse } from "./ping.js";

export class MainFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.bindingNames = Object.keys(env).sort();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") {
      return new Response("main facet ready");
    }

    if (path === "/facet/ping") {
      return pingResponse();
    }

    if (path === "/facet/bindings") {
      return Response.json(this.bindingNames);
    }

    if (path === "/facet/relay/echo") {
      return new Response(await request.text(), {
        status: 201,
        headers: {
          "x-facet-method": request.method,
          "x-facet-path": path,
          "x-facet-request-header": request.headers.get("x-request-header") || "",
          "x-facet-response-header": "preserved",
        },
      });
    }

    if (path === "/facet/relay/pre-header-failure") {
      throw new Error("facet failed before headers");
    }

    if (path === "/facet/relay/body-failure") {
      return new Response("partial", { headers: { "content-length": "8" } });
    }

    if (path === "/facet/relay/body-complete") {
      return new Response("complete body");
    }

    if (path === "/facet/relay/error-status") {
      return new Response("failure body", { status: 500 });
    }

    if (path === "/facet/relay/hang") {
      return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
    }

    return new Response("Not found", { status: 404 });
  }
}
`,
    },
    {
      name: "ping.js",
      source: `export function pingResponse() {
  return new Response("pong");
}
`,
    },
  ],
};
