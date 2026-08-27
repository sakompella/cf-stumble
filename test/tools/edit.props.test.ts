import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { prepareEdit } from "../../src/tools/edit.js";
import { persistedExamples } from "../support/hegel.js";
import { expectErr, expectOk } from "../support/result.js";

/**
 * A generative layer over `edit.test.ts`. `prepareEdit` is the pure decision point behind the
 * workspace primitive: its result is safe to apply only when the search text identifies one site.
 */

const surroundingText = gs.text({ maxSize: 40, excludeCharacters: "\u{10FFFF}\u{10FFFE}" });

const uniqueEdits = gs.composite((tc) => {
  const oldPayload = tc.draw(gs.text({ maxSize: 20, excludeCharacters: "\u{10FFFF}" }));
  const newPayload = tc.draw(gs.text({ maxSize: 20, excludeCharacters: "\u{10FFFE}" }));
  return {
    before: tc.draw(surroundingText),
    oldText: `\u{10FFFF}${oldPayload}\u{10FFFF}`,
    newText: `\u{10FFFE}${newPayload}\u{10FFFE}`,
    after: tc.draw(surroundingText),
  };
});

test("a successful edit changes only its uniquely matched span", () => {
  hegel.test((tc) => {
    const { before, oldText, newText, after } = tc.draw(uniqueEdits);

    expect(expectOk(prepareEdit("file.txt", `${before}${oldText}${after}`, oldText, newText))).toBe(
      `${before}${newText}${after}`,
    );
  }, persistedExamples);
});

test("an edit whose search text occurs twice is always rejected", () => {
  hegel.test((tc) => {
    const { before, oldText, newText, after } = tc.draw(uniqueEdits);
    const current = `${before}${oldText}${after}x${oldText}${before}`;

    const error = expectErr(prepareEdit("file.txt", current, oldText, newText));
    expect(error).toMatchObject({ _tag: "EditAmbiguousMatchError", occurrences: 2 });
  }, persistedExamples);
});

test("an edit whose search text is absent is always rejected", () => {
  hegel.test((tc) => {
    const { before, oldText, newText, after } = tc.draw(uniqueEdits);

    expect(expectErr(prepareEdit("file.txt", `${before}${after}`, oldText, newText))).toMatchObject(
      {
        _tag: "EditNoMatchError",
      },
    );
  }, persistedExamples);
});

test("reversing a successful edit restores the original text", () => {
  hegel.test((tc) => {
    const { before, oldText, newText, after } = tc.draw(uniqueEdits);
    const original = `${before}${oldText}${after}`;
    const edited = expectOk(prepareEdit("file.txt", original, oldText, newText));

    expect(expectOk(prepareEdit("file.txt", edited, newText, oldText))).toBe(original);
  }, persistedExamples);
});
