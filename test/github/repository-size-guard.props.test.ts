import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  MAX_REPOSITORY_BLOB_BYTES,
  MAX_REPOSITORY_BLOB_COUNT,
  MAX_REPOSITORY_SIZE_KB,
  REPOSITORY_SIZE_VERDICT_FUNCTION,
  repositorySizeReason,
  repositorySizeVerdictSource,
} from "../../src/github/index.js";
import { parseProjectCatalog, type Project } from "../../src/project-catalog.js";
import {
  PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE,
  planProjectProvision,
  projectProvisionConfiguration,
  projectProvisionStep,
} from "../../src/project-provision.js";
import {
  STUB_GIT,
  scratchDirectory,
  underScratch,
  writeExecutable,
} from "../workspace/planned-shell-fixture.js";

/**
 * These tests run the planned shell under `/bin/sh` with a stub `gh` and, for the clone step, a
 * stub `git`. The stub `gh` answers from canned JSON through the host's `jq`, while the real `gh`
 * evaluates `--jq` with its built-in gojq. They show what the shell decides for a given GitHub
 * answer; they do not show that GitHub, the real `gh`, or Computer behave the same way.
 */

const jq = execFileSync("/bin/sh", ["-c", "command -v jq"], { encoding: "utf8" }).trim();

const project: Project = (() => {
  const parsed = parseProjectCatalog([
    {
      id: "sample-repo-1",
      displayName: "Repo one",
      repositoryUrl: "https://github.com/sample/repo-1",
    },
  ])?.[0];

  if (parsed === undefined) throw new Error("the sample project must parse");

  return parsed;
})();

const scratch = scratchDirectory("cf-stumble-size-guard-");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

type GitHubAnswer = Readonly<{ exitCode: number; body: string }>;

type Scenario = Readonly<{
  repository: GitHubAnswer;
  tree: GitHubAnswer;
  /** Put the stub `gh` on PATH at all. */
  gh?: boolean;
  /** Answer `git rev-parse` as an existing clone would. */
  existingClone?: boolean;
}>;

/** The JSON a canned GitHub answer holds. */
type CannedJson =
  | string
  | number
  | boolean
  | null
  | readonly CannedJson[]
  | Readonly<{ [field: string]: CannedJson }>;

function answered(body: CannedJson): GitHubAnswer {
  return { exitCode: 0, body: JSON.stringify(body) };
}

const STUB_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/gh.log"
case "$2" in
  */git/trees/*) answer=tree ;;
  *) answer=repository ;;
esac
code="$(cat "$STUB_DIR/$answer.exit")"
if [ "$code" != 0 ]; then
  printf 'HTTP 404: Not Found\\n' >&2
  exit "$code"
fi
exec "$STUB_JQ" -r "$4" "$STUB_DIR/$answer.json"
`;

let scenarioCount = 0;

/** A fresh directory holding the stubs and the canned GitHub answers for one run. */
function prepare(scenario: Scenario): string {
  scenarioCount += 1;
  const directory = join(scratch, String(scenarioCount));
  const bin = join(directory, "bin");
  execFileSync("mkdir", ["-p", bin]);

  writeFileSync(join(directory, "repository.json"), scenario.repository.body);
  writeFileSync(join(directory, "repository.exit"), String(scenario.repository.exitCode));
  writeFileSync(join(directory, "tree.json"), scenario.tree.body);
  writeFileSync(join(directory, "tree.exit"), String(scenario.tree.exitCode));

  if (scenario.gh !== false) writeExecutable(join(bin, "gh"), STUB_GH);

  writeExecutable(join(bin, "git"), STUB_GIT);

  if (scenario.existingClone === true) writeFileSync(join(directory, "existing-clone"), "");

  return directory;
}

function run(directory: string, source: string) {
  return spawnSync("/bin/sh", ["-c", source], {
    encoding: "utf8",
    env: {
      PATH: `${join(directory, "bin")}:/usr/bin:/bin`,
      STUB_DIR: directory,
      STUB_JQ: jq,
      STUB_REMOTE: project.repositoryUrl,
    },
  });
}

function verdict(scenario: Scenario): string {
  const directory = prepare(scenario);

  const ran = run(
    directory,
    [repositorySizeVerdictSource(project.repositoryUrl), REPOSITORY_SIZE_VERDICT_FUNCTION].join(
      "\n",
    ),
  );

  expect(ran.status, ran.stderr).toBe(0);

  return ran.stdout.trim();
}

/** The real clone step, with `/workspace` moved under this run's scratch directory. */
function clone(scenario: Scenario) {
  const directory = prepare(scenario);

  const step = projectProvisionStep(
    planProjectProvision(projectProvisionConfiguration(project.id), project),
    "clone",
  );

  if (step.name !== "clone") throw new Error("the clone step must be the command step");

  const ran = run(directory, underScratch(step.source, directory));

  const log = (name: string) =>
    existsSync(join(directory, name))
      ? execFileSync("cat", [join(directory, name)], { encoding: "utf8" })
      : "";

  return { status: ran.status, stderr: ran.stderr, gitLog: log("git.log"), ghLog: log("gh.log") };
}

/** Split `total` bytes over `count` blobs, so a generated tree hits both ceilings exactly. */
function blobs(count: number, total: number): readonly Readonly<{ type: string; size: number }>[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "blob",
    size: Math.floor(total / count) + (index < total % count ? 1 : 0),
  }));
}

test("the in-workspace verdict agrees with the Supervisor's size policy", () => {
  hegel.test(
    (tc) => {
      const sizeKb = tc.draw(
        gs.oneOf(
          gs.integers({ minValue: 0, maxValue: 2 * MAX_REPOSITORY_SIZE_KB }),
          gs.sampledFrom([MAX_REPOSITORY_SIZE_KB, MAX_REPOSITORY_SIZE_KB + 1]),
        ),
      );

      const blobCount = tc.draw(
        gs.oneOf(
          gs.integers({ minValue: 1, maxValue: 50 }),
          gs.sampledFrom([MAX_REPOSITORY_BLOB_COUNT, MAX_REPOSITORY_BLOB_COUNT + 1]),
        ),
      );

      const blobBytes = tc.draw(
        gs.oneOf(
          gs.integers({ minValue: blobCount, maxValue: 2 * MAX_REPOSITORY_BLOB_BYTES }),
          gs.sampledFrom([MAX_REPOSITORY_BLOB_BYTES, MAX_REPOSITORY_BLOB_BYTES + 1]),
        ),
      );

      const truncated = tc.draw(gs.booleans());

      const shell = verdict({
        repository: answered({ size: sizeKb, default_branch: "feature/a b" }),
        tree: answered({ truncated, tree: [{ type: "tree" }, ...blobs(blobCount, blobBytes)] }),
      });

      expect(shell).toBe(repositorySizeReason({ sizeKb, blobCount, blobBytes, truncated }));
    },
    { testCases: 12 },
  );
}, 30_000);

test.each([
  [
    "gh is missing",
    { gh: false, repository: answered({ size: 1, default_branch: "main" }), tree: answered({}) },
  ],
  [
    "the repository request fails",
    { repository: { exitCode: 1, body: "" }, tree: answered({ truncated: false, tree: [] }) },
  ],
  [
    "the tree request fails",
    {
      repository: answered({ size: 1, default_branch: "main" }),
      tree: { exitCode: 1, body: "" },
    },
  ],
  [
    "the repository answer is malformed",
    {
      repository: answered({ size: "large", default_branch: "main" }),
      tree: answered({ truncated: false, tree: [] }),
    },
  ],
  [
    "a blob size is malformed",
    {
      repository: answered({ size: 1, default_branch: "main" }),
      tree: answered({ truncated: false, tree: [{ type: "blob", size: "10" }] }),
    },
  ],
  [
    "the tree has no truncation flag",
    {
      repository: answered({ size: 1, default_branch: "main" }),
      tree: answered({ tree: [] }),
    },
  ],
] as const)("the verdict is unmeasured when %s", (_case, scenario: Scenario) => {
  expect(verdict(scenario)).toBe("unmeasured");
});

test("the clone step refuses an oversized repository before it clones", () => {
  const ran = clone({
    repository: answered({ size: 1, default_branch: "main" }),
    tree: answered({ truncated: false, tree: blobs(MAX_REPOSITORY_BLOB_COUNT + 1, 10_000) }),
  });

  expect(ran.status).toBe(PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE);
  expect(ran.stderr).toContain("too-many-files");
  expect(ran.gitLog, "nothing was cloned").toBe("");
});

test("the clone step clones a repository within the limits", () => {
  const ran = clone({
    repository: answered({ size: 1, default_branch: "main" }),
    tree: answered({ truncated: false, tree: blobs(10, 1_000) }),
  });

  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.gitLog).toBe("clone\n");
});

test("the clone step still clones when GitHub cannot be measured", () => {
  const ran = clone({ repository: { exitCode: 1, body: "" }, tree: { exitCode: 1, body: "" } });

  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.gitLog).toBe("clone\n");
});

test("an existing clone is neither measured nor recloned", () => {
  const ran = clone({
    existingClone: true,
    repository: answered({ size: 1, default_branch: "main" }),
    tree: answered({ truncated: false, tree: blobs(MAX_REPOSITORY_BLOB_COUNT + 1, 10_000) }),
  });

  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.ghLog).toBe("");
  expect(ran.gitLog).toBe("");
});
