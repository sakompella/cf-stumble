import { devShellTool } from "../dev-shell-tool.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  credentialStatusSource,
  installCredentialSource,
  repositoryAccessSource,
} from "../../src/github/index.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, GIT_GLOBAL_CONFIG_PATH } from "../../src/workspace-layout.js";
import {
  scratchDirectory,
  underScratch,
  writeExecutable,
} from "../workspace/planned-shell-fixture.js";

const scratch = scratchDirectory("cf-stumble-credential-commands-");

const stubs = join(scratch, "bin");

const environmentLog = join(scratch, "environment.log");

const RECORDING_STUB = `#!/bin/sh
printf '%s %s\\n' "\${GH_CONFIG_DIR:-}" "\${GIT_CONFIG_GLOBAL:-}" >> "${environmentLog}"
exit 0
`;

mkdirSync(stubs);

for (const name of ["gh", "git"]) writeExecutable(join(stubs, name), RECORDING_STUB);

writeExecutable(join(stubs, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n');

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function environmentsSeenBy(source: string): readonly string[] {
  rmSync(environmentLog, { force: true });

  const ran = spawnSync(devShellTool("sh"), ["-c", source], {
    encoding: "utf8",
    input: "token\n",
    env: { PATH: `${stubs}:${process.env["PATH"] ?? ""}` },
  });

  expect(ran.status, ran.stderr).toBe(0);

  return readFileSync(environmentLog, "utf8").trim().split("\n");
}

test.each([
  ["install", installCredentialSource()],
  ["status", credentialStatusSource()],
  ["repository access", repositoryAccessSource("https://github.com/owner/repo")],
])("every gh and git call the %s command makes sees the durable configuration", (_name, source) => {
  const seen = environmentsSeenBy(source);

  expect(seen.length).toBeGreaterThan(0);

  for (const environment of seen) {
    expect(environment).toBe(`${GITHUB_CLI_CONFIG_DIRECTORY} ${GIT_GLOBAL_CONFIG_PATH}`);
  }
});

test("an install sets up Git's credential helper for github.com, so Git can use the credential", () => {
  const area = scratchDirectory("cf-stumble-credential-helper-");
  const areaStubs = join(area, "bin");

  mkdirSync(areaStubs);
  writeExecutable(
    join(areaStubs, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "auth setup-git")
    printf '[credential "https://github.com"]\n\thelper = !gh auth git-credential\n' >> "$GIT_CONFIG_GLOBAL"
    ;;
esac
exit 0
`,
  );

  const root = join(area, "root");

  mkdirSync(join(root, "workspace"), { recursive: true });

  const ran = spawnSync(devShellTool("sh"), ["-c", underScratch(installCredentialSource(), root)], {
    encoding: "utf8",
    input: "token\n",
    env: { PATH: `${areaStubs}:${process.env["PATH"] ?? ""}` },
  });

  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toBe("installed\n");

  const helper = spawnSync(
    devShellTool("git"),
    [
      "config",
      "--file",
      join(root, "workspace/.gitconfig"),
      "--get",
      "credential.https://github.com.helper",
    ],
    { encoding: "utf8" },
  );

  expect(helper.status, helper.stderr).toBe(0);
  expect(helper.stdout.trim()).toBe("!gh auth git-credential");

  rmSync(area, { recursive: true, force: true });
});

function statusAnswer(gh: Readonly<{ tokenStored: boolean; user: string; userFailure?: string }>) {
  const area = scratchDirectory("cf-stumble-credential-status-");
  const areaStubs = join(area, "bin");
  const lookups = join(area, "lookups.log");

  mkdirSync(areaStubs);
  writeExecutable(
    join(areaStubs, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "auth token") exit ${gh.tokenStored ? 0 : 1} ;;
  "api user")
    printf 'api user\\n' >> "${lookups}"
    ${
      gh.userFailure === undefined
        ? `printf '%s\\n' '${gh.user}'; exit 0`
        : `printf '%s\\n' '${gh.userFailure}' >&2; exit 1`
    }
    ;;
esac
exit 1
`,
  );

  const ran = spawnSync(devShellTool("sh"), ["-c", credentialStatusSource()], {
    encoding: "utf8",
    env: { PATH: `${areaStubs}:${process.env["PATH"] ?? ""}` },
  });

  expect(ran.status, ran.stderr).toBe(0);

  const answer = ran.stdout.trim();
  const askedGitHub = existsSync(lookups);

  rmSync(area, { recursive: true, force: true });

  return { answer, askedGitHub };
}

test("a stored token that GitHub rejects with a 401 reads as unusable", () => {
  expect(
    statusAnswer({
      tokenStored: true,
      user: "",
      userFailure: "gh: Bad credentials (HTTP 401)",
    }).answer,
  ).toBe("unusable");
});

test.each([
  'Get "https://api.github.com/user": dial tcp: lookup api.github.com: no such host',
  "gh: Bad Gateway (HTTP 502)",
  "gh: API rate limit exceeded (HTTP 403)",
])("a check that GitHub could not answer (%s) reads as no verdict, not as unusable", (failure) => {
  expect(statusAnswer({ tokenStored: true, user: "", userFailure: failure }).answer).toBe(
    "unreachable",
  );
});

test("a workspace with no stored token reads as missing without asking GitHub", () => {
  expect(statusAnswer({ tokenStored: false, user: "octocat" })).toEqual({
    answer: "missing",
    askedGitHub: false,
  });
});

test("a stored token that GitHub accepts reads as connected with the login", () => {
  expect(statusAnswer({ tokenStored: true, user: "octocat" }).answer).toBe("connected octocat");
});
