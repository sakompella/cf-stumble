import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { shellQuote } from "../src/shell-quote.js";

const shellText = gs.text({
  alphabet: "a'\\\"$`!*? \n;|&()<>{}~#%",
  maxSize: 16,
});

test("/bin/sh evaluates shellQuote to the original text", () => {
  hegel.test(
    (tc) => {
      const value = `'$${tc.draw(shellText)}`;

      const echoed = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], {
        encoding: "utf8",
      });

      expect(echoed).toBe(value);
    },
    { testCases: 40 },
  );
});
