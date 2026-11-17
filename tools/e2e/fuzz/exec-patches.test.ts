import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { PATCHED_FACET_FILES, patchFacetFile } from "./exec-commit.mts";

it("the exec fuzzer's patches apply to the facet sources checked in today and wire in the fuzz tools and model", () => {
  const patched = PATCHED_FACET_FILES.map((path) =>
    patchFacetFile(path, readFileSync(path, "utf8")),
  ).join("\n");

  assert.match(patched, /registry\.install\(FuzzTools\)/u);
  assert.match(patched, /routeProvider\(fuzzModel\(input\.model\), log\)/u);
});
