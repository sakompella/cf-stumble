import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { OWNER_PAGE_SCRIPT_SOURCE } from "../src/page/owner-script.generated.ts";

/**
 * Size ceilings for what a deploy uploads and what the owner's browser downloads, so a change that
 * grows past its expected cost fails here instead of in production. The Worker limit is the size
 * the Foldkit spike measured for the finished port plus about 10 percent. The page limit is the
 * Foldkit page's measured size plus about 10 percent (200,595 bytes gzip in Wave 5). ADR-0046
 * records the measured values.
 *
 * gzip runs at the default level, which reproduces the "gzip" figure `wrangler deploy` prints.
 */
const KIB = 1024;

const WORKER_UPLOAD_GZIP_LIMIT = 600 * KIB;

const OWNER_SCRIPT_GZIP_LIMIT = 216 * KIB;

const repoRoot = resolve(import.meta.dirname, "..");

const outdir = mkdtempSync(join(tmpdir(), "cf-stumble-budget-"));

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

/**
 * The modules `wrangler deploy` would upload, without uploading them. `--containers-rollout=none`
 * skips the container image build, which needs Docker and does not change the Worker. Wrangler
 * also runs the configured build command, so the bundle holds the current page script.
 */
function workerUploadGzipBytes(): number {
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "deploy", "--dry-run", "--containers-rollout=none", "--outdir", outdir],
    { cwd: repoRoot, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );

  const modules = readdirSync(outdir).filter((name) => name.endsWith(".js"));

  assert.ok(modules.length > 0, "wrangler wrote no Worker module");

  return modules
    .map((name) => gzipSync(readFileSync(join(outdir, name))).length)
    .reduce((total, size) => total + size, 0);
}

describe("bundle budgets", () => {
  it(`the Worker upload stays within ${WORKER_UPLOAD_GZIP_LIMIT / KIB} KiB gzip`, () => {
    const size = workerUploadGzipBytes();

    assert.ok(size <= WORKER_UPLOAD_GZIP_LIMIT, `the Worker upload is ${size} bytes gzip`);
  });

  it(`the owner page script stays within ${OWNER_SCRIPT_GZIP_LIMIT / KIB} KiB gzip`, () => {
    const size = gzipSync(OWNER_PAGE_SCRIPT_SOURCE).length;

    assert.ok(size <= OWNER_SCRIPT_GZIP_LIMIT, `the owner page script is ${size} bytes gzip`);
  });
});
