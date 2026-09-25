import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { posix } from "node:path";
import { expect, test } from "vitest";
import { addressedPathOf, parseAddressedPath } from "../../../src/workspace/project/resolve.js";

type AddressCandidate = string | number | boolean | null | Record<string, never>;

const arbitraryPath = gs.oneOf(
  gs.text({ alphabet: "ab/.\\\u0000", maxSize: 20 }),
  gs.text({ alphabet: "abc", maxSize: 16 }).map((suffix) => (suffix === "" ? "/" : `/a/${suffix}`)),
  gs.sampledFrom([null, 0, false, {}, "relative/path", "/a//b", "/a/../b", "/a/"]),
);

function isAcceptedByOracle(value: AddressCandidate): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The independent oracle accepts only strings.
  if (typeof value !== "string") return false;

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
      const knownBackslashInput = "/a\\b";
      const knownBackslash = parseAddressedPath(knownBackslashInput);

      expect(knownBackslash.ok).toBe(isAcceptedByOracle(knownBackslashInput));

      const expected = isAcceptedByOracle(input);

      expect(parsed.ok).toBe(expected);

      if (parsed.ok) expect(addressedPathOf(parsed.value)).toBe(input);
    },
    { testCases: 100 },
  );
});
