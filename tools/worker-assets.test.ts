import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readUploadedAssets } from "../infra/worker-bundle.ts";

describe("the static assets that Alchemy uploads with the Worker", () => {
  it("run the Worker before the asset layer, so the owner gate covers every file", async () => {
    const uploaded = await readUploadedAssets();

    assert.equal(uploaded.config?.runWorkerFirst, true);
  });
});
