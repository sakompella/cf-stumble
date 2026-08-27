import { describe, expect, it } from "vitest";

import { encodeObject, hashObject } from "../../src/git/index.js";

describe("git object hashes", () => {
  it("hashes the complete empty-blob object with Web Crypto SHA-1", async () => {
    const bytes = encodeObject({ type: "blob", data: new Uint8Array() });

    await expect(hashObject(bytes)).resolves.toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});
