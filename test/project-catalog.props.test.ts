import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { canonicalRepositoryUrl, projectIdForRepository } from "../src/project-catalog.js";

const segment = gs.text({ alphabet: "abcXYZ012", minSize: 1, maxSize: 12 });

const host = gs.sampledFrom(["github.com", "GitHub.com", "GITHUB.COM"]);

const suffix = gs.sampledFrom(["", ".git", "/", ".git/"]);

/**
 * URL spelling is user input, but the canonical spelling is the value used both for cloning and
 * for deriving identity. This property generates repository paths instead of repeating the three
 * hand-picked spellings in the workerd sibling: every case must converge to one URL and id.
 */
test("canonical repository spelling is a fixpoint and preserves repository identity", () => {
  hegel.test((tc) => {
    const owner = tc.draw(segment);
    const repository = tc.draw(segment);
    const written = `https://${tc.draw(host)}/${owner}/${repository}${tc.draw(suffix)}`;
    const canonical = canonicalRepositoryUrl(written);

    expect(canonical).toBe(`https://github.com/${owner}/${repository}`);
    expect(canonicalRepositoryUrl(canonical)).toBe(canonical);
    expect(projectIdForRepository(written)).toBe(projectIdForRepository(canonical));
  });
});
