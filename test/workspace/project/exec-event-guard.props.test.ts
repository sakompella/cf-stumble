import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { isExecEvent } from "../../../src/workspace/project/protocol.js";

test("an exited terminal is an exec event exactly when its exit code is a number, whatever else it carries", () => {
  hegel.test(
    (tc) => {
      const [exitCode, valid] = tc.draw(
        gs.oneOf<readonly [unknown, boolean]>(
          gs.integers({ minValue: -300, maxValue: 300 }).map((code) => [code, true] as const),
          gs.text({ maxSize: 3 }).map((code) => [code, false] as const),
        ),
      );

      const extra = tc.draw(
        gs.sampledFrom([{}, { fullOutputPaths: ["/.cf-stumble/output/run.stdout.log"] }]),
      );

      const seq = tc.draw(gs.integers({ minValue: 0, maxValue: 50 }));

      expect(isExecEvent({ kind: "terminal", seq, outcome: "exited", exitCode, ...extra })).toBe(
        valid,
      );
    },
    { testCases: 200 },
  );
});
