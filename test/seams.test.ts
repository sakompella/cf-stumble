import { Result } from "better-result";
import { expect, test } from "vitest";
import { isSha, parseSha, parseShaResult } from "../src/git/types.js";
import { expectErr, expectOk } from "./support/result.js";

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

test("parseShaResult accepts a real git object id", () => {
  expect(expectOk(parseShaResult(EMPTY_BLOB))).toBe(EMPTY_BLOB);
});

test("parseShaResult reports malformed input at the boundary", () => {
  expect(expectErr(parseShaResult(EMPTY_BLOB.toUpperCase()))).toMatchObject({
    _tag: "InvalidShaError",
    value: EMPTY_BLOB.toUpperCase(),
  });
  expect(expectErr(parseShaResult("abc"))).toMatchObject({ _tag: "InvalidShaError" });
  expect(isSha("")).toBe(false);
});

test("parseSha throws, which is why it is only for re-parsing hex we produced ourselves", () => {
  expect(parseSha(EMPTY_BLOB)).toBe(EMPTY_BLOB);
  expect(() => parseSha(EMPTY_BLOB.toUpperCase())).toThrow(TypeError);
  expect(() => parseSha("abc")).toThrow(TypeError);
});

/**
 * The two entry points must agree on what an object id is. If the trusted one were the more
 * permissive, a string the request boundary rejected could still reach the domain by way of a
 * re-parse, which is the whole failure the split is meant to prevent.
 */
test("parseSha and parseShaResult accept exactly the same strings", () => {
  const cases = [
    EMPTY_BLOB,
    EMPTY_BLOB.toUpperCase(),
    EMPTY_BLOB.slice(0, 39),
    `${EMPTY_BLOB}0`,
    ` ${EMPTY_BLOB}`,
    "abc",
    "",
  ];

  for (const value of cases) {
    expect({ value, accepted: acceptedByParseSha(value) }).toEqual({
      value,
      accepted: Result.isOk(parseShaResult(value)),
    });
  }
});

function acceptedByParseSha(value: string): boolean {
  try {
    parseSha(value);
    return true;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(TypeError);
    return false;
  }
}
