import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { parseHarnessCommit } from "../src/harness-commit.js";

const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const validCommit = gs.fromRegex("(?:[0-9a-f]{40}|[0-9a-f]{64})");

const invalidLength = gs
  .sampledFrom([39, 41, 63, 65])
  .flatMap((length) => gs.text({ alphabet: "0123456789abcdef", minSize: length, maxSize: length }));

function replaceAt(value: string, index: number, replacement: string): string {
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

test("parses generated lowercase hexadecimal commit IDs unchanged", () => {
  hegel.test((tc) => {
    const value = tc.draw(validCommit);

    expect(parseHarnessCommit(value)).toBe(value);
  });
});

test("handles arbitrary text and accepts exactly documented commit syntax", () => {
  hegel.test((tc) => {
    const value = tc.draw(gs.text());

    expect(parseHarnessCommit(value) === undefined).toBe(!commitPattern.test(value));
  });
});

test("rejects generated hexadecimal commits with an invalid length", () => {
  hegel.test((tc) => {
    expect(parseHarnessCommit(tc.draw(invalidLength))).toBeUndefined();
  });
});

test("rejects generated lowercase hexadecimal commits with an uppercase mutation", () => {
  hegel.test((tc) => {
    const value = tc.draw(validCommit);
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: value.length - 1 }));

    expect(parseHarnessCommit(replaceAt(value, index, "A"))).toBeUndefined();
  });
});

test("rejects generated lowercase hexadecimal commits with a non-hex mutation", () => {
  hegel.test((tc) => {
    const value = tc.draw(validCommit);
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: value.length - 1 }));

    expect(parseHarnessCommit(replaceAt(value, index, "g"))).toBeUndefined();
  });
});
