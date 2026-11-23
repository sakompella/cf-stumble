import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { workerAssetDirectory } from "../infra/worker-settings.ts";
import { OWNER_SCRIPT_SOURCE } from "../src/page/owner-script.generated.ts";
import { PIERRE_SCRIPT_PATH } from "../src/page/pierre-script.generated.ts";

const KIB = 1024;

const PIERRE_SCRIPT_SOURCE = readFileSync(
  resolve(import.meta.dirname, "..", workerAssetDirectory, `.${PIERRE_SCRIPT_PATH}`),
);

const BUDGETS = [
  { name: "owner page script", source: OWNER_SCRIPT_SOURCE, limit: 256 * KIB },
  { name: "Pierre renderer script", source: PIERRE_SCRIPT_SOURCE, limit: 383 * KIB },
];

describe("bundle budgets", () => {
  for (const { name, source, limit } of BUDGETS) {
    it(`the ${name} stays within ${limit / KIB} KiB gzip`, () => {
      const size = gzipSync(source).length;

      assert.ok(size <= limit, `the ${name} is ${size} bytes gzip`);
    });
  }
});
