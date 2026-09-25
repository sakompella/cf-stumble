import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import {
  canonicalRepositoryUrl,
  parseProjectCatalog,
  parseProjectId,
  PROJECT_ID_LIMIT,
  projectIdForRepository,
  resolveProject,
} from "../src/project-catalog.js";
import { HARNESS_PROJECT_ID } from "../src/selectable-projects.js";

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

/**
 * GitHub owner names are letters, digits, and hyphens. Repository names add `.` and `_`. The small
 * alphabets put every punctuation mark next to every other and next to a boundary, which is where
 * the lowercase dash-joined spelling of an older id collapsed distinct repositories.
 */
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

/** The same letters with every repository punctuation mark redrawn: the old id cannot tell them apart. */
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

/**
 * A name such as `.` or `.git` is no repository at all: the URL parser or canonicalization removes
 * it. Every other drawn name is one GitHub could hold.
 */
function canonicalOf(repository: Repository): string | undefined {
  return canonicalRepositoryUrl(urlOf(repository));
}

/**
 * GitHub resolves owner and repository names without regard to case, so two canonical URLs that
 * differ only in case are one repository. Any other difference is a different repository.
 */
function sameRepository(left: Repository, right: Repository): boolean {
  return canonicalOf(left)?.toLowerCase() === canonicalOf(right)?.toLowerCase();
}

/**
 * The id names a project's thread, its SQLite rows, and its directory, so two repositories that
 * share one lose one of them. The second repository is drawn two ways: independently, and as the
 * first one with its punctuation redrawn, because that pair is the one a lossy id merges.
 */
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

/**
 * Every id becomes a directory under /workspace/projects, a URL path segment, and a SQLite key,
 * and the Workspace Host checks it again with `parseProjectId`. The provisioning script also
 * names `<id>.provisioning` and `<id>.provision-lock` beside it, so an id must never contain a dot
 * or it could name another project's staging directory.
 */
test("derives an id for every GitHub repository name that is safe as a path segment", () => {
  hegel.test((tc) => {
    const repository = drawRepository(tc);
    tc.assume(canonicalOf(repository) !== undefined);
    const id = idOf(repository);

    expect(id).toBeDefined();
    expect(id).toMatch(/^[a-z0-9-]+$/u);
    expect(id?.length).toBeLessThanOrEqual(PROJECT_ID_LIMIT);
    expect(parseProjectId(id)).toBe(id);
    expect(encodeURIComponent(id ?? "")).toBe(id);
    expect(id).not.toBe(HARNESS_PROJECT_ID);
  });
});

const plainOwner = gs.text({ alphabet: "aZ0", minSize: 1, maxSize: 6 });

const plainWord = gs.text({ alphabet: "aZ0", minSize: 1, maxSize: 4 });

/**
 * Ids of repositories whose owner has no hyphen and whose name is words joined by single hyphens
 * keep the spelling every earlier id had, so projects connected before injective ids keep their
 * threads and directories. The old spelling is restated here rather than imported.
 */
test("keeps the earlier id of every owner without a hyphen and name without dots or underscores", () => {
  hegel.test((tc) => {
    const owner = tc.draw(plainOwner);
    const name = tc.draw(gs.arrays(plainWord, { minSize: 1, maxSize: 4 })).join("-");
    const earlier = `${owner}-${name}`.toLowerCase();

    expect(projectIdForRepository(`https://github.com/${owner}/${name}`)).toBe(earlier);
  });
});

type RawProject = Readonly<{
  id: string | undefined;
  displayName: string;
  repositoryUrl: string;
}>;

function drawRawCatalog(tc: hegel.TestCase): RawProject[] {
  const count = tc.draw(gs.integers({ minValue: 2, maxValue: 6 }));

  return Array.from({ length: count }, (_, index) => {
    const repository = tc.draw(gs.fromRegex("[a-z]{1,6}"));
    const repositoryUrl = `https://github.com/owner${index}/${repository}`;

    return {
      id: projectIdForRepository(repositoryUrl),
      displayName: `project ${index}`,
      repositoryUrl,
    };
  });
}

test("resolves each catalog id to its own project regardless of position", () => {
  hegel.test((tc) => {
    const raw = drawRawCatalog(tc);
    const catalog = parseProjectCatalog(raw);
    expect(catalog).toBeDefined();

    if (catalog === undefined) throw new Error("generated catalog must be valid");

    const absentId = "absent-project";
    const expectedById = new Map(catalog.map((project) => [project.id, project]));
    const rotation = tc.draw(gs.integers({ minValue: 0, maxValue: catalog.length - 1 }));
    const permuted = [...catalog.slice(rotation), ...catalog.slice(0, rotation)];

    for (const [id, expected] of expectedById) {
      expect(resolveProject(id, catalog)).toEqual({ ok: true, project: expected });
      expect(resolveProject(id, permuted)).toEqual({ ok: true, project: expected });
    }

    expect(resolveProject(absentId, catalog)).toEqual({
      ok: false,
      reason: "unknown-project-id",
    });
  });
});

test("rejects duplicate catalog ids even when duplicate rows are far apart", () => {
  hegel.test((tc) => {
    const raw = drawRawCatalog(tc);
    const duplicate = raw[0];

    if (duplicate === undefined) throw new Error("generated catalog must be non-empty");

    expect(
      parseProjectCatalog([...raw, { ...duplicate, displayName: "duplicate" }]),
    ).toBeUndefined();
  });
});
