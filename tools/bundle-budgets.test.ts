import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { OWNER_PAGE_SCRIPT_SOURCE } from "../src/page/owner-script.generated.ts";

const KIB = 1024;

const OWNER_SCRIPT_GZIP_LIMIT = 256 * KIB;

describe("bundle budgets", () => {
  it(`the owner page script stays within ${OWNER_SCRIPT_GZIP_LIMIT / KIB} KiB gzip`, () => {
    const size = gzipSync(OWNER_PAGE_SCRIPT_SOURCE).length;

    assert.ok(size <= OWNER_SCRIPT_GZIP_LIMIT, `the owner page script is ${size} bytes gzip`);
  });
});
