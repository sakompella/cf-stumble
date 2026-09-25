import { expect, test } from "vitest";
import { addressedPathOf, parseAddressedPath } from "../../../src/workspace/project/resolve.js";

test("round-trips a clean addressed root path", () => {
  const parsed = parseAddressedPath("/workspace/file.txt");

  expect(parsed).toEqual({ ok: true, value: ["workspace", "file.txt"] });

  if (parsed.ok) expect(addressedPathOf(parsed.value)).toBe("/workspace/file.txt");
});
