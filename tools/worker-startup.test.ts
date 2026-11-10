import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { buildWorkerBundle } from "../infra/worker-bundle.ts";
import { testWorker } from "../infra/test-worker.ts";

const OWNER_AUTHORIZATION = `Basic ${btoa(`aditya:${testWorker.miniflare.bindings.OWNER_PASSWORD}`)}`;

function workerModules(files: Awaited<ReturnType<typeof buildWorkerBundle>>) {
  return files
    .filter((file) => !file.path.endsWith(".map"))
    .map((file) => {
      assert.ok(
        file.path.endsWith(".js"),
        `the deploy bundle has a module of unknown type: ${file.path}`,
      );

      return { type: "ESModule" as const, path: `/${file.path}`, contents: file.content };
    });
}

describe("the deploy bundle of the Worker", () => {
  let worker: Miniflare;

  before(async () => {
    worker = new Miniflare(
      convertV4MiniflareOptions({
        ...testWorker.miniflare,
        modulesRoot: "/",
        modules: workerModules(await buildWorkerBundle()),
      }),
    );
    await worker.ready;
  });

  after(() => worker.dispose());

  it("starts and answers a request", async () => {
    const response = await worker.dispatchFetch("http://localhost/health");

    assert.deepEqual(await response.json(), { ok: true });
  });

  it("constructs the Supervisor and the WorkspaceHost for an owner request", async () => {
    const response = await worker.dispatchFetch("http://localhost/api/workspace/backend", {
      headers: { authorization: OWNER_AUTHORIZATION },
    });

    assert.equal(response.status, 200, await response.text());
  });
});
