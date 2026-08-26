import { describe, expect, it } from "vitest";

import { decodeObject, encodeObject } from "../../src/git/index.js";

describe("git blob objects", () => {
  it("encodes an empty blob with its exact object header", () => {
    const encoded = encodeObject({ type: "blob", data: new Uint8Array() });

    expect(new TextDecoder().decode(encoded)).toBe("blob 0\0");
  });

  it("preserves binary blob content, including embedded NUL bytes", () => {
    const data = Uint8Array.from([0, 1, 2, 255, 0]);
    const encoded = encodeObject({ type: "blob", data });

    expect(decodeObject(encoded)).toEqual({ type: "blob", data });
  });
});
