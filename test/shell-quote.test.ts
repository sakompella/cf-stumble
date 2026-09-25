import { expect, test } from "vitest";
import { shellQuote } from "../src/shell-quote.js";

test("shellQuote emits POSIX single-quote escaping the shell can parse", () => {
  expect(shellQuote("plain")).toBe("'plain'");
  expect(shellQuote("/workspace/harness/.git")).toBe("'/workspace/harness/.git'");
  expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");

  expect(shellQuote("a'b")).toBe("'a'\\''b'");
  expect(shellQuote("'")).toBe("''\\'''");
});
