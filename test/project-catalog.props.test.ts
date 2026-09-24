import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { canonicalRepositoryUrl } from "../src/project-catalog.js";

const alphanumeric = gs.text({ alphabet: "abcXYZ012", minSize: 1, maxSize: 8 });

const interior = gs.text({ alphabet: "abcXYZ012-._", maxSize: 8 });

function drawSegment(tc: hegel.TestCase): string {
  return `${tc.draw(alphanumeric)}${tc.draw(interior)}${tc.draw(alphanumeric)}`;
}

/**
 * URL spelling is user input, but the canonical spelling is the value used both for cloning and
 * for deriving identity. This property generates repository paths instead of repeating the three
 * hand-picked spellings in the workerd sibling: every case must converge to one URL and id.
 */
test("all spellings of a generated owner and repository share one canonical URL", () => {
  hegel.test((tc) => {
    const owner = drawSegment(tc);
    const repository = drawSegment(tc);
    const expected = `https://github.com/${owner}/${repository}`;

    const spellings = [
      `https://github.com/${owner}/${repository}`,
      `https://GitHub.com/${owner}/${repository}.git`,
      `https://github.com/${owner}/${repository}/`,
      `https://GITHUB.COM/${owner}/${repository}.git/`,
      `https://github.com/${owner}/${repository}.git.git`,
      `https://github.com/${owner}/${repository}.git.git/`,
    ];

    for (const spelling of spellings) {
      const canonical = canonicalRepositoryUrl(spelling);

      expect(canonical).toBe(expected);
      expect(canonicalRepositoryUrl(canonical)).toBe(expected);
    }
  });
});
