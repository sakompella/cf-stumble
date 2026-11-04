import { devShellTool } from "../dev-shell-tool.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  credentialStatusSource,
  installCredentialSource,
  repositoryAccessSource,
} from "../../src/github/index.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, GIT_GLOBAL_CONFIG_PATH } from "../../src/workspace-layout.js";
import { scratchDirectory, writeExecutable } from "../workspace/planned-shell-fixture.js";

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
