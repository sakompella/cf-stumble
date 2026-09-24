import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import {
  canonicalRepositoryUrl,
  parseProjectCatalog,
  projectIdForRepository,
} from "../src/project-catalog.js";

const alphanumeric = gs.text({ alphabet: "abcXYZ012", minSize: 1, maxSize: 8 });

const interior = gs.text({ alphabet: "abcXYZ012-._", maxSize: 8 });

const host = gs.sampledFrom(["github.com", "GitHub.com", "GITHUB.COM"]);

const suffix = gs.sampledFrom(["", ".git", "/", ".git/"]);

function drawSegment(tc: hegel.TestCase): string {
  return `${tc.draw(alphanumeric)}${tc.draw(interior)}${tc.draw(alphanumeric)}`;
}

/**
 * URL spelling is user input, but the canonical spelling is the value used both for cloning and
 * for deriving identity. This property generates repository paths instead of repeating the three
 * hand-picked spellings in the workerd sibling: every case must converge to one URL and id.
 */
test("canonical repository spelling is a fixpoint and preserves repository identity", () => {
  hegel.test((tc) => {
    const owner = drawSegment(tc);
    const repository = drawSegment(tc);
    const written = `https://${tc.draw(host)}/${owner}/${repository}${tc.draw(suffix)}`;
    const canonical = canonicalRepositoryUrl(written);

    if (canonical === undefined)
      throw new Error("generated repository URL must be canonicalizable");

    expect(canonicalRepositoryUrl(canonical)).toBe(canonical);
    expect(projectIdForRepository(written)).toBe(projectIdForRepository(canonical));
  });
});

test("a catalog refuses two different canonical repositories that collide on one project id", () => {
  hegel.test((tc) => {
    const owner = drawSegment(tc);
    const stem = tc.draw(alphanumeric);
    const firstUrl = `https://github.com/${owner}/${stem}-repo`;
    const secondUrl = `https://github.com/${owner}/${stem}.repo`;
    const firstCanonical = canonicalRepositoryUrl(firstUrl);
    const secondCanonical = canonicalRepositoryUrl(secondUrl);
    const id = projectIdForRepository(firstUrl);

    if (firstCanonical === undefined || secondCanonical === undefined || id === undefined) {
      throw new Error("generated collision URLs must be valid");
    }

    expect(firstCanonical).not.toBe(secondCanonical);
    expect(projectIdForRepository(secondUrl)).toBe(id);
    expect(
      parseProjectCatalog([
        { id, displayName: "first", repositoryUrl: firstCanonical },
        { id, displayName: "second", repositoryUrl: secondCanonical },
      ]),
    ).toBeUndefined();
  });
});
