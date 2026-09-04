import type { MainHarnessArtifactInput } from "./artifact.js";

/**
 * A hand-written main-facet module map for tests, and the invented harness commit that labels it.
 * Production reaches no code here: the deploy procedure submits the deployed harness commit and
 * the Supervisor builds it, so nothing under `src/` may import this file.
 * `test/facet/fixture-reach.test.ts` checks that.
 *
 * Tests import it directly rather than through `./index.js`, which is what keeps it out of the
 * production surface. It stays beside `artifact.ts` because it is one input to that parser.
 */
export const fixtureMainHarnessCommit = "f53a0e1c1bdbe213ab700a84b1db23615cc24b02";

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
    this.model = env.MODEL;
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

    if (path === "/facet/model") {
      return Response.json(await this.model.run({ prompt: await request.text() }));
    }

    if (path === "/facet/outbound") {
      try {
        await fetch("https://example.com/");
        return Response.json({ ok: true });
      } catch {
        return Response.json({ ok: false, error: "outbound-blocked" });
      }
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
