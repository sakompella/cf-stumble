import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { posix } from "node:path";
import { expect, test } from "vitest";
import { addressedPathOf, parseAddressedPath } from "../../../src/workspace/project/resolve.js";

const arbitraryPath = gs.oneOf(
  gs.text({ alphabet: "ab/.\\\u0000", maxSize: 20 }),
  gs.text({ alphabet: "ab", maxSize: 16 }).map((suffix) => `/a/${suffix}\\`),
  gs.text({ alphabet: "ab", maxSize: 16 }).map((suffix) => `/a/${suffix}\u0000`),
  gs.text({ alphabet: "abc", maxSize: 16 }).map((suffix) => (suffix === "" ? "/" : `/a/${suffix}`)),
  gs.sampledFrom(["relative/path", "/a//b", "/a/../b", "/a/"]),
);

function isAcceptedByOracle(value: string): boolean {
  if (!value.startsWith("/")) return false;

  if (value.includes("\\") || value.includes("\0")) return false;

  if (posix.normalize(value) !== value) return false;

  return value === "/" || !value.endsWith("/");
}

test("parseAddressedPath accepts exactly clean absolute normalized paths", () => {
  hegel.test(
    (tc) => {
      const input = tc.draw(arbitraryPath);
      const parsed = parseAddressedPath(input);
      const expected = isAcceptedByOracle(input);

      expect(Result.isSuccess(parsed)).toBe(expected);

      if (Result.isSuccess(parsed)) expect(addressedPathOf(parsed.success)).toBe(input);
    },
    { testCases: 100 },
  );
});
