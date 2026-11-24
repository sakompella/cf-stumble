import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { buildWorkerBundle, readUploadedAssets } from "../infra/worker-bundle.ts";
import { testWorker } from "../infra/test-worker.ts";
import { OWNER_PAGE_SCRIPT_SOURCE } from "../src/page/owner-script.generated.ts";

const OWNER_AUTHORIZATION = `Basic ${btoa(`aditya:${testWorker.miniflare.bindings.OWNER_PASSWORD}`)}`;

const KIB = 1024;

const WORKER_UPLOAD_GZIP_LIMIT = 700 * KIB;

const OWNER_SCRIPT_GZIP_LIMIT = 256 * KIB;

type Files = Awaited<ReturnType<typeof buildWorkerBundle>>;

function uploaded(files: Files): Files[number][] {
  return files.filter((file) => !file.path.endsWith(".map"));
}

function workerModules(files: Files) {
  return uploaded(files).map((file) => {
    assert.ok(
      file.path.endsWith(".js"),
      `the deploy bundle has a module of unknown type: ${file.path}`,
    );

    return { type: "ESModule" as const, path: `/${file.path}`, contents: file.content };
  });
}

describe("the deploy bundle of the Worker", () => {
  let worker: Miniflare;
  let files: Files;

  before(async () => {
    files = await buildWorkerBundle();
    worker = new Miniflare(
      convertV4MiniflareOptions({
        ...testWorker.miniflare,
        modulesRoot: "/",
        modules: workerModules(files),
      }),
    );
    await worker.ready;
  });

  after(() => worker.dispose());

  it(`uploads at most ${WORKER_UPLOAD_GZIP_LIMIT / KIB} KiB gzip`, () => {
    const size = uploaded(files).reduce((total, file) => total + gzipSync(file.content).length, 0);

    assert.ok(size <= WORKER_UPLOAD_GZIP_LIMIT, `the Worker upload is ${size} bytes gzip`);
  });

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

describe("the static assets that Alchemy uploads with the Worker", () => {
  it("run the Worker before the asset layer, so the owner gate covers every file", async () => {
    const assets = await readUploadedAssets();

    assert.equal(assets.config?.runWorkerFirst, true);
  });
});

describe("the owner page script", () => {
  it(`stays within ${OWNER_SCRIPT_GZIP_LIMIT / KIB} KiB gzip`, () => {
    const size = gzipSync(OWNER_PAGE_SCRIPT_SOURCE).length;

    assert.ok(size <= OWNER_SCRIPT_GZIP_LIMIT, `the owner page script is ${size} bytes gzip`);
  });
});
