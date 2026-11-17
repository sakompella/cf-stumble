import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { parseCount } from "../src/count.js";

const digitsOrNot = gs.oneOf(
  gs.text({ alphabet: "0123456789", minSize: 1, maxSize: 20 }),
  gs.text({ alphabet: "0123456789+-.exX ", maxSize: 6 }),
  gs.text({ maxSize: 6 }),
);

test("a count is defined exactly when the text is decimal digits that make a safe integer", () => {
  hegel.test((tc) => {
    const text = tc.draw(digitsOrNot);
    const readable = /^[0-9]+$/u.test(text) && Number.isSafeInteger(Number(text));

    expect(parseCount(text) !== undefined).toBe(readable);
  });
});

test("every safe count reads back from its decimal text", () => {
  hegel.test((tc) => {
    const count = tc.draw(gs.integers({ minValue: 0, maxValue: Number.MAX_SAFE_INTEGER }));

    expect(parseCount(String(count))).toBe(count);
  });
});

test("text that Number would read as another number is refused", () => {
  for (const text of ["1e3", "0x10", "+5", " 5", "5 ", "5.0", "-1", "", "٣"]) {
    expect(parseCount(text), text).toBeUndefined();
  }
});
