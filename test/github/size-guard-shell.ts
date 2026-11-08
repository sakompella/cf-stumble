import { devShellTool } from "../dev-shell-tool.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  REPOSITORY_SIZE_VERDICT_FUNCTION,
  repositorySizeVerdictSource,
} from "../../src/github/index.js";
import { projectCloneSource } from "../../src/workspace/commands/provision-project.js";
import {
  FLOCK_STAND_IN,
  STUB_GIT,
  scratchDirectory,
  systemToolsDirectory,
  underScratch,
  writeExecutable,
} from "../workspace/planned-shell-fixture.js";
import { projectOf } from "../project-fixtures.js";

const jq = devShellTool("jq");

const project = projectOf("https://github.com/sample/repo-1");

const scratch = scratchDirectory("cf-stumble-size-guard-");

export function removeScratch(): void {
  rmSync(scratch, { recursive: true, force: true });
}

type GitHubAnswer = Readonly<{ exitCode: number; body: string; raw?: boolean }>;

export type Scenario = Readonly<{
  repository: GitHubAnswer;
  tree: GitHubAnswer;
  gh?: boolean;
  existingClone?: boolean;
}>;

type CannedJson =
  | string
  | number
  | boolean
  | null
  | readonly CannedJson[]
  | Readonly<{ [field: string]: CannedJson }>;

export function answered(body: CannedJson): GitHubAnswer {
  return { exitCode: 0, body: JSON.stringify(body) };
}

export function printedAsIs(text: string): GitHubAnswer {
  return { exitCode: 0, body: text, raw: true };
}

const STUB_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_DIR/gh.log"
case "$2" in
  */git/trees/*) answer=tree ;;
  *) answer=repository ;;
esac
code="$(cat "$STUB_DIR/$answer.exit")"
if [ "$code" != 0 ]; then
  printf 'HTTP 404: Not Found (Authorization: token %s)\\n' "$STUB_SECRET" >&2
  exit "$code"
fi
if [ -e "$STUB_DIR/$answer.raw" ]; then
  cat "$STUB_DIR/$answer.raw"
  exit 0
fi
exec "$STUB_JQ" -r "$4" "$STUB_DIR/$answer.json"
`;

export const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

const systemTools = systemToolsDirectory(scratch);

const stubs = join(scratch, "bin");

const stubsWithoutGh = join(scratch, "bin-without-gh");

for (const bin of [stubs, stubsWithoutGh]) {
  mkdirSync(bin);
  writeExecutable(join(bin, "git"), STUB_GIT);
  writeExecutable(join(bin, "flock"), FLOCK_STAND_IN);
}

writeExecutable(join(stubs, "gh"), STUB_GH);

let scenarioCount = 0;

function prepare(scenario: Scenario) {
  scenarioCount += 1;
  const directory = join(scratch, String(scenarioCount));
  execFileSync("mkdir", ["-p", join(directory, "tmp")]);

  writeFileSync(join(directory, "repository.json"), scenario.repository.body);
  writeFileSync(join(directory, "repository.exit"), String(scenario.repository.exitCode));
  writeFileSync(join(directory, "tree.json"), scenario.tree.body);
  writeFileSync(join(directory, "tree.exit"), String(scenario.tree.exitCode));

  for (const [name, answer] of [
    ["repository", scenario.repository],
    ["tree", scenario.tree],
  ] as const) {
    if (answer.raw === true) writeFileSync(join(directory, `${name}.raw`), answer.body);
  }

  if (scenario.existingClone === true) writeFileSync(join(directory, "existing-clone"), "");

  return { directory, bin: scenario.gh === false ? stubsWithoutGh : stubs };
}

function run({ directory, bin }: ReturnType<typeof prepare>, source: string) {
  return spawnSync(devShellTool("sh"), ["-c", source], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${systemTools}`,
      STUB_DIR: directory,
      STUB_JQ: jq,
      STUB_SECRET: FAKE_TOKEN,
      STUB_REMOTE: project.repositoryUrl,
    },
  });
}

export function verdict(scenario: Scenario): string {
  const ran = run(
    prepare(scenario),
    [repositorySizeVerdictSource(project.repositoryUrl), REPOSITORY_SIZE_VERDICT_FUNCTION].join(
      "\n",
    ),
  );

  expect(ran.status, ran.stderr).toBe(0);
  expect(`${ran.stdout}${ran.stderr}`, "gh's error text never leaves the check").not.toContain(
    FAKE_TOKEN,
  );

  return ran.stdout.trim();
}

export function clone(scenario: Scenario) {
  const prepared = prepare(scenario);

  const ran = run(prepared, underScratch(projectCloneSource(project), prepared.directory));

  const log = (name: string) =>
    existsSync(join(prepared.directory, name))
      ? execFileSync("cat", [join(prepared.directory, name)], { encoding: "utf8" })
      : "";

  return { status: ran.status, stderr: ran.stderr, gitLog: log("git.log"), ghLog: log("gh.log") };
}

export function blobs(
  count: number,
  total: number,
): readonly Readonly<{ type: string; size: number }>[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "blob",
    size: Math.floor(total / count) + (index < total % count ? 1 : 0),
  }));
}
