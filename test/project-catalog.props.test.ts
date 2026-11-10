import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { canonicalRepositoryUrl, projectIdForRepository } from "../src/project-catalog.js";
import { projectIdFromPath, routePattern } from "../src/routes/route-pattern.js";
import { HARNESS_PROJECT_ID } from "../src/selectable-projects.js";

const alphanumeric = gs.text({ alphabet: "abcXYZ012", minSize: 1, maxSize: 8 });

const interior = gs.text({ alphabet: "abcXYZ012-._", maxSize: 8 });

function drawSegment(tc: hegel.TestCase): string {
  return `${tc.draw(alphanumeric)}${tc.draw(interior)}${tc.draw(alphanumeric)}`;
}

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
      expect(canonicalRepositoryUrl(canonical ?? "")).toBe(expected);
    }
  });
});

const ownerHead = gs.text({ alphabet: "aZ0", minSize: 1, maxSize: 1 });

const ownerTail = gs.text({ alphabet: "aZ0-", maxSize: 6 });

const repositoryName = gs.text({ alphabet: "aZ0-._", minSize: 1, maxSize: 8 });

const punctuation = gs.sampledFrom(["-", ".", "_"]);

type Repository = Readonly<{ owner: string; name: string }>;

function drawRepository(tc: hegel.TestCase): Repository {
  const owner = `${tc.draw(ownerHead)}${tc.draw(ownerTail)}`;
  const name = tc.draw(repositoryName);

  return { owner, name };
}

function drawRepunctuated(tc: hegel.TestCase, repository: Repository): Repository {
  const name = repository.name.replaceAll(/[-._]/gu, () => tc.draw(punctuation));

  return { owner: repository.owner, name };
}

function urlOf(repository: Repository): string {
  return `https://github.com/${repository.owner}/${repository.name}`;
}

function idOf(repository: Repository): string | undefined {
  return projectIdForRepository(urlOf(repository));
}

function canonicalOf(repository: Repository): string | undefined {
  return canonicalRepositoryUrl(urlOf(repository));
}

function sameRepository(left: Repository, right: Repository): boolean {
  return canonicalOf(left)?.toLowerCase() === canonicalOf(right)?.toLowerCase();
}

test("gives distinct repositories distinct ids and one repository one id", () => {
  hegel.test((tc) => {
    const first = drawRepository(tc);
    tc.assume(canonicalOf(first) !== undefined);
    const firstId = idOf(first);

    for (const second of [drawRepository(tc), drawRepunctuated(tc, first)]) {
      if (canonicalOf(second) === undefined) {
        continue;
      }

      const secondId = idOf(second);

      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();

      if (sameRepository(first, second)) {
        expect(secondId).toBe(firstId);
      } else {
        expect(secondId).not.toBe(firstId);
      }
    }
  });
});

const wideOwner = gs.text({ alphabet: "aZ0-", minSize: 1, maxSize: 39 });

const wideName = gs.text({ alphabet: "aZ0-._", minSize: 1, maxSize: 100 });

test("every short GitHub repository name derives an id", () => {
  hegel.test((tc) => {
    const repository = drawRepository(tc);
    tc.assume(canonicalOf(repository) !== undefined);

    expect(idOf(repository)).toBeDefined();
  });
});

test("an id derived for a repository of any GitHub size is the id its API routes carry", () => {
  hegel.test((tc) => {
    const repository = { owner: tc.draw(wideOwner), name: tc.draw(wideName) };
    const id = idOf(repository);
    tc.assume(id !== undefined);

    const path = `/api/projects/${id ?? ""}/messages`;

    expect(routePattern(path)).toBe("/api/projects/:projectId/messages");
    expect(projectIdFromPath(path, "/messages")).toBe(id);
    expect(id).not.toBe(HARNESS_PROJECT_ID);
  });
});

const plainOwner = gs.text({ alphabet: "aZ0", minSize: 1, maxSize: 6 });

const plainWord = gs.text({ alphabet: "aZ0", minSize: 1, maxSize: 4 });

test("keeps the earlier id of every owner without a hyphen and name without dots or underscores", () => {
  hegel.test((tc) => {
    const owner = tc.draw(plainOwner);
    const name = tc.draw(gs.arrays(plainWord, { minSize: 1, maxSize: 4 })).join("-");
    const earlier = `${owner}-${name}`.toLowerCase();

    expect(projectIdForRepository(`https://github.com/${owner}/${name}`)).toBe(earlier);
  });
});

const separatorOf = new Map([
  ["s", "/"],
  ["h", "-"],
  ["d", "."],
  ["u", "_"],
]);

function nameOfId(id: string): string {
  const [slug = "", key = ""] = id.split("--");
  const words = slug.split("-");
  const written = new Map<number, string>();

  for (const [, position, codes] of key.matchAll(/(\d+)([dhsu]+)/gu)) {
    written.set(
      Number(position),
      (codes ?? "")
        .split("")
        .map((code) => separatorOf.get(code) ?? "?")
        .join(""),
    );
  }

  return words
    .map((word, index) => {
      const position = index + 1;
      const usual = position === words.length ? "" : position === 1 ? "/" : "-";

      return `${word}${written.get(position) ?? usual}`;
    })
    .join("");
}

const roundTripOwner = gs.text({ alphabet: "aZ0-", minSize: 1, maxSize: 12 });

const nameEdge = gs.text({ alphabet: "-._", maxSize: 2 });

const nameStep = gs.tuples(
  gs.sampledFrom(["-", ".", "_", "--", ".-", "_."]),
  gs.text({ alphabet: "aZ0", minSize: 1, maxSize: 2 }),
);

const roundTripName = gs.composite((tc) => {
  const first = `${tc.draw(nameEdge)}${tc.draw(gs.text({ alphabet: "aZ0", minSize: 1, maxSize: 2 }))}`;
  const rest = tc.draw(gs.arrays(nameStep, { maxSize: 14 }));

  return `${first}${rest.map(([separator, word]) => `${separator}${word}`).join("")}${tc.draw(nameEdge)}`;
});

test("an id names the repository it came from, so no two repositories share one", () => {
  hegel.test((tc) => {
    const owner = `${tc.draw(ownerHead)}${tc.draw(roundTripOwner)}`;
    const name = tc.draw(roundTripName);
    const id = projectIdForRepository(`https://github.com/${owner}/${name}`);

    if (name === "." || name === "..") {
      expect(id).toBeUndefined();

      return;
    }

    expect(id).toBeDefined();
    expect(nameOfId(id ?? "")).toBe(`${owner}/${name}`.toLowerCase());
  });
});

function recased(tc: hegel.TestCase, text: string): string {
  return text
    .split("")
    .map((character) => (tc.draw(gs.booleans()) ? character.toUpperCase() : character))
    .join("");
}

test("every spelling of one repository derives the same id", () => {
  hegel.test((tc) => {
    const owner = `${tc.draw(ownerHead)}${tc.draw(ownerTail)}`;
    const repository = drawSegment(tc);
    const plain = projectIdForRepository(`https://github.com/${owner}/${repository}`.toLowerCase());
    const host = tc.draw(gs.sampledFrom(["github.com", "GitHub.COM", "github.com:443"]));
    const suffix = ".git".repeat(tc.draw(gs.integers({ minValue: 0, maxValue: 3 })));
    const slashes = "/".repeat(tc.draw(gs.integers({ minValue: 0, maxValue: 2 })));
    const spelling = `https://${host}/${recased(tc, owner)}/${recased(tc, repository)}${suffix}${slashes}`;

    expect(plain).toBeDefined();
    expect(projectIdForRepository(spelling)).toBe(plain);
  });
});
