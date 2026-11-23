import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { buildWorkerBundle } from "../infra/worker-bundle.ts";
import { compatibility } from "../infra/worker-settings.ts";

describe("the tailnet service capability", () => {
  let worker: Miniflare;
  let allowlisted: Miniflare;

  before(async () => {
    const files = await buildWorkerBundle("src/tailnet-worker.ts");

    const options = {
      compatibilityDate: compatibility.date,
      compatibilityFlags: [...compatibility.flags],
      modulesRoot: "/",
      modules: files
        .filter((file) => !file.path.endsWith(".map"))
        .map((file) => ({
          type: file.path.endsWith(".wasm") ? ("CompiledWasm" as const) : ("ESModule" as const),
          path: `/${file.path}`,
          contents: file.content,
        })),
      durableObjects: { NODE: { className: "TailnetObject", useSQLite: true } },
    };

    worker = new Miniflare(convertV4MiniflareOptions(options));
    allowlisted = new Miniflare(
      convertV4MiniflareOptions({
        ...options,
        bindings: { TAILNET_ALLOWED_HOSTS: "hp.tail.example" },
      }),
    );

    await Promise.all([worker.ready, allowlisted.ready]);
  });

  after(() => Promise.all([worker?.dispose(), allowlisted?.dispose()]));

  it("refuses a host with an empty allowlist without starting a node", async () => {
    const response = await worker.dispatchFetch("http://hp/");
    assert.equal(response.status, 403);
  });

  it("refuses a host outside the exact owner allowlist", async () => {
    for (const host of ["hp.tail.example.attacker.test", "attacker.test", "100.64.0.1"]) {
      const response = await allowlisted.dispatchFetch(`http://${host}/`);
      assert.equal(response.status, 403);
    }
  });
});
