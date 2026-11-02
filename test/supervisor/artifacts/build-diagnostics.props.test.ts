import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { redactLogText } from "../../../src/diagnostics.js";
import { built, failingAt } from "./scripted-build-host.js";

const TOKEN_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const filler = gs.sampledFrom([" ", ".", "é", "😀"]);

const secret = gs.oneOf(
  gs.text({ alphabet: TOKEN_CHARACTERS, minSize: 36, maxSize: 40 }).map((body) => `ghp_${body}`),
  gs
    .text({ alphabet: TOKEN_CHARACTERS, minSize: 8, maxSize: 20 })
    .map((part) => `eyJ${part}.eyJ${part}.${part}`),
);

const repeats = gs.integers({ minValue: 0, maxValue: 2_100 });

const totalLength = gs.oneOf(
  gs.integers({ minValue: 0, maxValue: 4_200 }),
  gs.integers({ minValue: 1_990, maxValue: 2_040 }),
);

function windowsOf(text: string, size: number): string[] {
  return Array.from({ length: text.length - size + 1 }, (_unused, start) =>
    text.slice(start, start + size),
  );
}

test("a failed step's tail is the well-formed end of its redacted output, and no piece of a secret survives", async () => {
  await hegel.testAsync(
    async (tc) => {
      const before = tc.draw(filler).repeat(tc.draw(repeats));
      const injected = tc.draw(gs.optional(secret)) ?? "";

      const after = tc
        .draw(gs.sampledFrom([" ", ".", "é"]))
        .repeat(Math.max(0, tc.draw(totalLength) - before.length - injected.length));

      const stderr = `${before}${injected}${after}`;
      const redacted = redactLogText(stderr);

      const result = await built(failingAt("provision", { stderr }));

      if (Result.isSuccess(result) || result.failure.code !== "build-step-failed") {
        throw new Error("the step must fail with a build-step-failed problem");
      }

      const { stderrTail, truncated } = result.failure.diagnostics;

      expect(stderrTail.length).toBeLessThanOrEqual(2_000);
      expect(/\p{Cs}/u.test(stderrTail)).toBe(false);
      expect(redacted.endsWith(stderrTail)).toBe(true);
      expect(truncated).toBe(redacted.length > 2_000);

      if (truncated) expect(stderrTail.length).toBeGreaterThanOrEqual(1_999);
      else expect(stderrTail).toBe(redacted);

      for (const piece of injected === "" ? [] : windowsOf(injected, 8)) {
        expect(stderrTail).not.toContain(piece);
      }
    },
    { testCases: 200 },
  );
});
