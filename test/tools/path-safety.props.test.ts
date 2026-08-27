import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Result } from "better-result";
import { expect, test } from "vitest";

import {
  isWorkspacePath,
  parseWorkspacePath,
  type WorkspacePathRejection,
} from "../../src/tools/index.js";

/**
 * A property layer over `test/tools/path-safety.test.ts`, which pins one example per rejection
 * reason. This is a security boundary — every path the primitives touch passes through it — and
 * those examples only prove the seven reasons are reachable, not that nothing slips between them.
 *
 * Candidates are drawn as raw strings and go through `parseWorkspacePath`, the real entry point,
 * so the brand is applied by its type predicate and never asserted (ADR-0015).
 */

const REJECTIONS: readonly WorkspacePathRejection[] = [
  "empty",
  "absolute",
  "nul-byte",
  "backslash",
  "path-traversal",
  "dot-segment",
  "empty-segment",
];

/**
 * Half unconstrained text, half strings assembled from the fragments the classifier branches on.
 * Uniform text alone essentially never produces `..`, a drive letter or a doubled slash, so the
 * interesting half of the input space would go unexplored.
 */
const candidatePaths = gs.composite<string>((tc) => {
  if (tc.draw(gs.booleans())) {
    return tc.draw(gs.text());
  }
  const fragments = tc.draw(
    gs.arrays(
      gs.sampledFrom([
        "",
        ".",
        "..",
        "...",
        "/",
        "//",
        "\\",
        "\0",
        "C:",
        "a",
        "src",
        "app.ts",
        "café",
        "内容",
        "..a",
        "a..",
        ".hidden",
        " ",
        "\n",
      ]),
      { maxSize: 6 },
    ),
  );
  return fragments.join(tc.draw(gs.sampledFrom(["/", ""])));
});

test("parsing is total: every string yields a branded path or a tagged rejection", () => {
  hegel.test((tc) => {
    const raw = tc.draw(candidatePaths);

    const result = parseWorkspacePath(raw);

    if (Result.isOk(result)) {
      expect(result.value).toBe(raw);
      return;
    }
    const { _tag } = result.error;
    expect(_tag).toBe("InvalidWorkspacePathError");
    expect(result.error.path).toBe(raw);
    expect(REJECTIONS).toContain(result.error.rejection);
  });
});

test("an accepted path can never escape its workspace", () => {
  hegel.test((tc) => {
    const result = parseWorkspacePath(tc.draw(candidatePaths));
    if (Result.isError(result)) return;
    const accepted: string = result.value;

    // Restating the classifier would make this tautological, so assert what a caller relies on
    // when it joins the result onto a workspace root.
    expect(accepted).not.toBe("");
    expect(accepted.startsWith("/")).toBe(false);
    expect(/^[A-Za-z]:/u.test(accepted)).toBe(false);
    expect(accepted.includes("\0")).toBe(false);
    expect(accepted.includes("\\")).toBe(false);
    expect(accepted.split("/")).not.toContain("..");
    expect(accepted.split("/")).not.toContain(".");
    expect(accepted.split("/")).not.toContain("");
  });
});

test("the predicate and the parser agree on every string", () => {
  hegel.test((tc) => {
    const raw = tc.draw(candidatePaths);

    // `parseWorkspacePath` panics when its two gates disagree, so the panic is unobservable from
    // outside. This pins the weaker public claim: a caller may use either and get the same answer.
    expect(isWorkspacePath(raw)).toBe(Result.isOk(parseWorkspacePath(raw)));
  });
});

test("every rejection reason stays reachable, so the properties above are not vacuous", () => {
  const reached = new Set<WorkspacePathRejection>();

  hegel.test(
    (tc) => {
      const result = parseWorkspacePath(tc.draw(candidatePaths));
      if (Result.isError(result)) reached.add(result.error.rejection);
    },
    { testCases: 500 },
  );

  expect([...reached].toSorted()).toEqual([...REJECTIONS].toSorted());
});
