import { expect, test } from "vitest";
import {
  GITHUB_TOKEN_STAGING_PATH,
  REDACTED,
  type GitHubCredentialState,
} from "../../src/github/index.js";
import { PROJECTS_DIRECTORY, WORKSPACE_ROOT } from "../../src/workspace-layout.js";
import {
  executeGitHubCredentialRequest,
  type CommandOutput,
  type GitHubCredentialResult,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/index.js";

/**
 * The Workspace Host's credential surface, driven through a fake Computer.
 *
 * No test here runs a shell, so what a green run shows is which requests are accepted, where the
 * token is written, what text the commands are, and what the surface returns. The two properties
 * that matter for goal criterion 3 are checked directly: the token reaches exactly one place, a
 * private file outside every repository, and it appears in no command line and no result.
 */

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

class FakeCredentialOperations implements WorkspaceOperations {
  readonly writes: (readonly [string, string])[] = [];
  readonly sources: string[] = [];
  stdout = "";
  stderr = "";
  exitCode = 0;

  lstat(): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve("file");
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("the credential surface never reads a file"));
  }

  writeFile(path: string, content: string): Promise<void> {
    this.writes.push([path, content]);

    return Promise.resolve();
  }

  runCommand(source: string): Promise<CommandOutput> {
    this.sources.push(source);

    return Promise.resolve({ stdout: this.stdout, stderr: this.stderr, exitCode: this.exitCode });
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This helper passes test values to the public parsing boundary.
function credential(operations: FakeCredentialOperations, request: unknown) {
  return executeGitHubCredentialRequest({ operations, request });
}

function statusOf(result: GitHubCredentialResult): GitHubCredentialState | undefined {
  return result.ok && result.result.kind === "credential-status" ? result.result.state : void 0;
}

test("stages the token outside every repository and keeps it out of the command line", async () => {
  const operations = new FakeCredentialOperations();
  operations.stdout = "installed";

  const installed = await credential(operations, {
    kind: "github-credential",
    step: "install",
    token: FAKE_TOKEN,
  });

  expect(installed).toEqual({ ok: true, result: { kind: "credential-installed" } });
  expect(operations.writes[0]).toEqual([GITHUB_TOKEN_STAGING_PATH, `${FAKE_TOKEN}\n`]);
  expect(GITHUB_TOKEN_STAGING_PATH.startsWith(WORKSPACE_ROOT)).toBe(false);
  expect(GITHUB_TOKEN_STAGING_PATH.startsWith(PROJECTS_DIRECTORY)).toBe(false);
  expect(operations.sources.join("\n")).not.toContain(FAKE_TOKEN);
  expect(operations.sources[0]).toContain("gh auth login --hostname github.com --with-token");
  expect(operations.sources[0], "the credential is also usable from git").toContain(
    "gh auth setup-git",
  );
});

test("overwrites the staged token whatever the install did", async () => {
  const operations = new FakeCredentialOperations();
  operations.exitCode = 1;
  operations.stderr = "gh: something went wrong";

  const failed = await credential(operations, {
    kind: "github-credential",
    step: "install",
    token: FAKE_TOKEN,
  });

  expect(failed).toEqual({
    ok: false,
    error: { code: "credential-command-failed", detail: "gh: something went wrong" },
  });
  expect(operations.writes.at(-1)).toEqual([GITHUB_TOKEN_STAGING_PATH, ""]);
});

test("redacts a token a tool printed back before it leaves the workspace", async () => {
  const operations = new FakeCredentialOperations();
  operations.exitCode = 1;
  operations.stderr = `fatal: bad credentials for https://x-access-token:${FAKE_TOKEN}@github.com`;

  const failed = await credential(operations, {
    kind: "github-credential",
    step: "install",
    token: FAKE_TOKEN,
  });

  if (failed.ok) {
    throw new Error("a failing install must report a failure");
  }

  expect(failed.error.detail).not.toContain(FAKE_TOKEN);
  expect(failed.error.detail).toContain(REDACTED);
});

test("reports a workspace image without gh instead of pretending to install", async () => {
  const operations = new FakeCredentialOperations();
  operations.stdout = "tooling-missing";

  const installed = await credential(operations, {
    kind: "github-credential",
    step: "install",
    token: FAKE_TOKEN,
  });

  expect(statusOf(installed)).toBe("tooling-missing");
});

test.each([
  ["connected octocat", "connected", "octocat"],
  ["missing", "missing", undefined],
  ["unusable", "unusable", undefined],
  ["tooling-missing", "tooling-missing", undefined],
  ["something unexpected", "unusable", undefined],
])("reads %j as the %s credential state", async (stdout, state, login) => {
  const operations = new FakeCredentialOperations();
  operations.stdout = stdout;

  const status = await credential(operations, { kind: "github-credential", step: "status" });

  expect(status).toEqual({ ok: true, result: { kind: "credential-status", state, login } });
  expect(operations.sources[0]).toContain("gh auth status");
});

test("asks git whether a repository is readable, and redacts what git says when it is not", async () => {
  const granted = new FakeCredentialOperations();
  granted.stdout = "granted";
  const denied = new FakeCredentialOperations();
  denied.stdout = `denied fatal: could not read from https://user:${FAKE_TOKEN}@github.com/o/r`;

  const allowed = await credential(granted, {
    kind: "github-credential",
    step: "verify-repository",
    repositoryUrl: "https://github.com/owner/repo.git",
  });

  const refused = await credential(denied, {
    kind: "github-credential",
    step: "verify-repository",
    repositoryUrl: "https://github.com/owner/repo",
  });

  expect(allowed).toEqual({
    ok: true,
    result: { kind: "repository-access", granted: true, detail: "" },
  });
  expect(granted.sources[0]).toContain("git ls-remote --heads");
  expect(
    granted.sources[0],
    "the URL is canonical, so both spellings check one repository",
  ).toContain("'https://github.com/owner/repo'");

  if (!refused.ok || refused.result.kind !== "repository-access") {
    throw new Error("a denied repository must still be a result");
  }

  expect(refused.result.granted).toBe(false);
  expect(refused.result.detail).not.toContain(FAKE_TOKEN);
  expect(refused.result.detail).toContain(REDACTED);
});

test("refuses a request that is not one of the three credential steps", async () => {
  const operations = new FakeCredentialOperations();

  for (const request of [
    null,
    { kind: "github-credential" },
    { kind: "github-credential", step: "install" },
    { kind: "github-credential", step: "install", token: "has space" },
    { kind: "github-credential", step: "install", token: FAKE_TOKEN, extra: 1 },
    { kind: "github-credential", step: "status", token: FAKE_TOKEN },
    { kind: "github-credential", step: "verify-repository", repositoryUrl: "git@github.com:o/r" },
    { kind: "github-credential", step: "revoke" },
    { kind: "run-command", command: "check" },
  ]) {
    await expect(credential(operations, request)).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request", detail: "" },
    });
  }

  expect(operations.writes, "a refused request stages nothing").toEqual([]);
  expect(operations.sources, "a refused request runs nothing").toEqual([]);
});
