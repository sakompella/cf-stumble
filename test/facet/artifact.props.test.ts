import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import {
  parseMainHarnessArtifact,
  type MainHarnessArtifactInput,
  type MainHarnessArtifactProblem,
} from "../../src/facet/artifact.js";

const NAMES = ["a.js", "b.js", "c.js", "d.js"];

const modules = gs.arrays(
  gs
    .tuples(gs.sampledFrom(NAMES), gs.text({ maxSize: 4 }))
    .map(([name, source]) => ({ name, source })),
  { maxSize: 5 },
);

const harnessCommit = gs.oneOf(
  gs.text({ alphabet: "0123456789abcdef", minSize: 40, maxSize: 40 }),
  gs.text({ alphabet: "0123456789abcdef", minSize: 64, maxSize: 64 }),
  gs.text({ alphabet: "0123456789abcdefG", maxSize: 66 }),
);

function expectedProblem(input: MainHarnessArtifactInput): MainHarnessArtifactProblem | undefined {
  const names = input.modules.map((module) => module.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);

  if (names.length === 0) return { code: "empty-module-map" };

  if (repeated !== undefined) return { code: "duplicate-module-name", moduleName: repeated };

  if (!names.includes(input.entryModule)) {
    return { code: "entry-module-not-found", entryModule: input.entryModule };
  }

  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.harnessCommit)) {
    return { code: "invalid-harness-commit", harnessCommit: input.harnessCommit };
  }

  return undefined;
}

test("an artifact parses exactly when its module map is sound and its commit is valid, entry first", () => {
  hegel.test(
    (tc) => {
      const input = {
        harnessCommit: tc.draw(harnessCommit),
        entryModule: tc.draw(gs.sampledFrom(NAMES)),
        modules: tc.draw(modules),
      };

      const parsed = parseMainHarnessArtifact(input);
      const problem = expectedProblem(input);

      if (problem === undefined) {
        const artifact = Result.getOrThrow(parsed);

        expect(artifact.harnessCommit).toBe(input.harnessCommit);
        expect(artifact.modules).toEqual([
          ...input.modules.filter((module) => module.name === input.entryModule),
          ...input.modules.filter((module) => module.name !== input.entryModule),
        ]);
      } else {
        expect(Result.isFailure(parsed) ? parsed.failure : "parsed").toEqual(problem);
      }
    },
    { testCases: 300 },
  );
});
