import { expect, test } from "vitest";
import {
  canonicalizeObservableEffects,
  compareObservableEffects,
  type ObservableEffects,
} from "../../src/replay/comparison.js";

const expected: ObservableEffects = {
  trace: [
    { kind: "write", path: "src/main.ts", content: "export const answer = 42;\n" },
    { kind: "read", path: "README.md" },
  ],
  finalWorkspace: [
    { path: "README.md", content: "updated\n" },
    { path: "src/main.ts", content: "export const answer = 42;\n" },
  ],
};

test("canonicalizes the workspace tree independently of file ordering", () => {
  const actual: ObservableEffects = {
    trace: expected.trace,
    finalWorkspace: expected.finalWorkspace.toReversed(),
  };

  expect(canonicalizeObservableEffects(actual)).toEqual(expected);
  expect(compareObservableEffects(expected, actual)).toEqual({ equal: true });
});

test("detects a changed primitive call rather than comparing prose", () => {
  const actual: ObservableEffects = {
    trace: [
      { kind: "write", path: "src/main.ts", content: "export const answer = 7;\n" },
      { kind: "read", path: "README.md" },
    ],
    finalWorkspace: expected.finalWorkspace,
  };

  expect(compareObservableEffects(expected, actual)).toEqual({
    equal: false,
    difference: {
      kind: "trace",
      index: 0,
      expected: expected.trace[0],
      actual: actual.trace[0],
    },
  });
});

test("detects a changed final workspace", () => {
  const actual: ObservableEffects = {
    trace: expected.trace,
    finalWorkspace: [
      { path: "README.md", content: "old\n" },
      { path: "src/main.ts", content: "export const answer = 42;\n" },
    ],
  };

  expect(compareObservableEffects(expected, actual)).toEqual({
    equal: false,
    difference: {
      kind: "workspace",
      path: "README.md",
      expected: { path: "README.md", content: "updated\n" },
      actual: { path: "README.md", content: "old\n" },
    },
  });
});
