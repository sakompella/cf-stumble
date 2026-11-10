import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { OWNER_PAGE_SCRIPT_SOURCE } from "../src/page/owner-script.generated.ts";

const KIB = 1024;

const WORKER_UPLOAD_GZIP_LIMIT = 700 * KIB;

const OWNER_SCRIPT_GZIP_LIMIT = 240 * KIB;

const repoRoot = resolve(import.meta.dirname, "..");

function bundleWorker() {
  return build({
    entryPoints: [resolve(repoRoot, "src/worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    legalComments: "none",
    metafile: true,
  });
}

describe("bundle budgets", () => {
  it(`the Worker upload stays within ${WORKER_UPLOAD_GZIP_LIMIT / KIB} KiB gzip`, async () => {
    const bundled = await bundleWorker();
    const size = bundled.outputFiles.reduce(
      (total, file) => total + gzipSync(file.contents).length,
      0,
    );

    assert.ok(size <= WORKER_UPLOAD_GZIP_LIMIT, `the Worker upload is ${size} bytes gzip`);
  });

  it("the Worker leaves out pi-schema, whose FinalizationRegistry the Workers runtime lacks", async () => {
    const bundled = await bundleWorker();
    const kept = Object.values(bundled.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, input]) => input.bytesInOutput > 0)
        .map(([path]) => path),
    );

    assert.deepEqual(
      kept.filter((path) => path.includes("@earendil-works/pi-schema/")),
      [],
    );
  });

  it(`the owner page script stays within ${OWNER_SCRIPT_GZIP_LIMIT / KIB} KiB gzip`, () => {
    const size = gzipSync(OWNER_PAGE_SCRIPT_SOURCE).length;

    assert.ok(size <= OWNER_SCRIPT_GZIP_LIMIT, `the owner page script is ${size} bytes gzip`);
  });
});
