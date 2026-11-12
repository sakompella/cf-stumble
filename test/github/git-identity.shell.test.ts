import { devShellTool } from "../dev-shell-tool.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { installCredentialSource } from "../../src/github/index.js";
import {
  scratchDirectory,
  underScratch,
  writeExecutable,
} from "../workspace/planned-shell-fixture.js";

const contextFiles = import.meta.glob("../../infra/workspace-image/*", {
  eager: true,
  query: "?raw",
  import: "default",
});

const dockerfile = contextFiles["../../infra/workspace-image/computerd.Dockerfile"] ?? "";

function imageIdentity(key: "name" | "email"): string {
  const value = new RegExp(`git config --system user\\.${key} (\\S+)`, "u").exec(dockerfile)?.[1];

  if (value === undefined) throw new Error(`the image sets a system user.${key}`);

  return value;
}

const scratch = scratchDirectory("cf-stumble-git-identity-");

const git = devShellTool("git");

const stubs = join(scratch, "bin");

mkdirSync(stubs);

writeExecutable(
  join(stubs, "gh"),
  `#!/bin/sh
case "$1 $2" in
  "auth login" | "auth setup-git") : ;;
  "api user") printf "octo-owner\\n" ;;
esac
exit 0
`,
);

const environment = { PATH: `${dirname(git)}:${process.env["PATH"] ?? ""}`, HOME: scratch };

function runInstall(): string {
  const directory = join(scratch, "install");

  mkdirSync(join(directory, "workspace"), { recursive: true });

  const ran = spawnSync(
    devShellTool("sh"),
    ["-c", underScratch(installCredentialSource(), directory)],
    {
      encoding: "utf8",
      input: "token\n",
      env: { ...environment, PATH: `${stubs}:${environment.PATH}` },
    },
  );

  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout).toBe("installed\n");

  return join(directory, "workspace/.gitconfig");
}

function commitAuthor(configuration: Readonly<{ global: string; system: string }>): string {
  const repository = join(scratch, "repository");

  rmSync(repository, { recursive: true, force: true });
  mkdirSync(repository, { recursive: true });

  const configured = {
    ...environment,
    GIT_CONFIG_GLOBAL: configuration.global,
    GIT_CONFIG_SYSTEM: configuration.system,
  };

  const run = (arguments_: readonly string[]) =>
    spawnSync(git, arguments_, { encoding: "utf8", cwd: repository, env: configured });

  expect(run(["init", "--quiet"]).status).toBe(0);

  const committed = run(["commit", "--allow-empty", "--quiet", "--message", "probe"]);

  expect(committed.status, committed.stderr).toBe(0);

  return run(["log", "-1", "--format=%an <%ae>"]).stdout.trim();
}

function systemConfiguration(): string {
  const path = join(scratch, "system-gitconfig");

  for (const key of ["name", "email"] as const) {
    const written = spawnSync(git, ["config", "--file", path, `user.${key}`, imageIdentity(key)], {
      encoding: "utf8",
      env: environment,
    });

    expect(written.status, written.stderr).toBe(0);
  }

  return path;
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a credential install gives a fresh repository the owner's GitHub login as commit identity", () => {
  const author = commitAuthor({ global: runInstall(), system: "/dev/null" });

  expect(author).toBe("octo-owner <octo-owner@users.noreply.github.com>");
});

test("the image's fallback identity commits when no credential is installed", () => {
  const author = commitAuthor({
    global: join(scratch, "absent-gitconfig"),
    system: systemConfiguration(),
  });

  expect(author).toBe("cf-stumble <cf-stumble@users.noreply.github.com>");
});

test("a repository's own identity wins over the installed and fallback identities", () => {
  const repository = join(scratch, "repository");

  rmSync(repository, { recursive: true, force: true });
  mkdirSync(repository, { recursive: true });

  const configured = {
    ...environment,
    GIT_CONFIG_GLOBAL: runInstall(),
    GIT_CONFIG_SYSTEM: systemConfiguration(),
  };

  const run = (arguments_: readonly string[]) =>
    spawnSync(git, arguments_, { encoding: "utf8", cwd: repository, env: configured });

  expect(run(["init", "--quiet"]).status).toBe(0);
  expect(run(["config", "user.name", "repo-owner"]).status).toBe(0);
  expect(run(["config", "user.email", "repo-owner@example.com"]).status).toBe(0);

  const committed = run(["commit", "--allow-empty", "--quiet", "--message", "probe"]);

  expect(committed.status, committed.stderr).toBe(0);
  expect(run(["log", "-1", "--format=%an <%ae>"]).stdout.trim()).toBe(
    "repo-owner <repo-owner@example.com>",
  );
});
