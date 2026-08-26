import { expect, test } from "vitest";
import { isSha, parseSha } from "../src/git/types.js";

test("parseSha accepts a real git object id", () => {
  const empty = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
  expect(parseSha(empty)).toBe(empty);
});

test("parseSha rejects malformed input at the boundary", () => {
  expect(() => parseSha("E69DE29BB2D1D6434B8B29AE775AD8C2E48C5391")).toThrow(TypeError);
  expect(() => parseSha("abc")).toThrow(TypeError);
  expect(isSha("")).toBe(false);
});
