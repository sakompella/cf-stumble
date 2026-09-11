import { expect, test } from "vitest";
import { REDACTED, type GitHubCredentialState } from "../../src/github/index.js";
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
 * No test here runs a shell, so what a green run shows is which requests are accepted, how the
 * token is handed over, what text the commands are, and what the surface returns. The two
 * properties that matter for goal criterion 3 are checked directly: the token reaches the install
 * command on standard input and nothing else, and it appears in no command line and no result.
 */

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

class FakeCredentialOperations implements WorkspaceOperations {
  readonly writes: (readonly [string, string])[] = [];
  readonly sources: string[] = [];
  readonly stdins: (string | undefined)[] = [];
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

  runCommand(
    source: string,
    _cwd: string,
    _timeoutMs: number,
    stdin?: string,
  ): Promise<CommandOutput> {
    this.sources.push(source);
    this.stdins.push(stdin);

    return Promise.resolve({ stdout: this.stdout, stderr: this.stderr, exitCode: this.exitCode });
  }
}

/**
 * A workspace with no filesystem at all: every path operation rejects, whatever the path.
 *
 * Computer's workspace filesystem is not the container's, so `/tmp` and every other container
 * path is missing from it. This fake is the honest version of that: a surface that needs any file
 * cannot pass with it.
 */
class FilesystemlessOperations implements WorkspaceOperations {
  readonly sources: string[] = [];
  readonly stdins: (string | undefined)[] = [];
  stdout = "";
  stderr = "";
  exitCode = 0;
  commandFails = false;

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    return Promise.reject(new Error(`parent directory missing: ${path}`));
  }

  readFile(path: string): Promise<string> {
    return Promise.reject(new Error(`parent directory missing: ${path}`));
  }

  writeFile(path: string): Promise<void> {
    return Promise.reject(new Error(`parent directory missing: ${path}`));
  }

  runCommand(
    source: string,
    _cwd: string,
    _timeoutMs: number,
    stdin?: string,
  ): Promise<CommandOutput> {
    if (this.commandFails) return Promise.reject(new Error("workspace is unavailable"));
    this.sources.push(source);
    this.stdins.push(stdin);

    return Promise.resolve({ stdout: this.stdout, stderr: this.stderr, exitCode: this.exitCode });
  }
}

type CredentialOperations = FakeCredentialOperations | FilesystemlessOperations;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This helper passes test values to the public parsing boundary.
function credential(operations: CredentialOperations, request: unknown) {
  return executeGitHubCredentialRequest({ operations, request });
}

function statusOf(result: GitHubCredentialResult): GitHubCredentialState | undefined {
  return result.ok && result.result.kind === "credential-status" ? result.result.state : void 0;
}

test("hands the token to gh on standard input and keeps it out of the command line", async () => {
  const operations = new FakeCredentialOperations();
  operations.stdout = "installed";

  const installed = await credential(operations, {
    kind: "github-credential",
    step: "install",
    token: FAKE_TOKEN,
  });

  expect(installed).toEqual({ ok: true, result: { kind: "credential-installed" } });
  expect(operations.stdins[0], "standard input is how --with-token reads a token").toBe(
    `${FAKE_TOKEN}\n`,
  );
  expect(operations.sources.join("\n")).not.toContain(FAKE_TOKEN);
  expect(operations.sources[0]).toContain("gh auth login --hostname github.com --with-token");
  expect(operations.sources[0], "the credential is also usable from git").toContain(
    "gh auth setup-git",
  );
});

/**
 * The regression this file exists to prevent. The install used to write the token to a path and
 * have the command read it back, and the path was on the container's filesystem while the write
 * went to the workspace's, so every install failed as `workspace-unavailable` on a real
 * deployment and the cause was discarded.
 *
 * The property, not the path, is what is asserted: a workspace whose filesystem refuses every
 * operation must still install a credential. Any install that needs a file anywhere fails this,
 * whatever path it picks.
 */
test("installs a credential without touching a filesystem at all", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = "installed";

  const installed = await credential(operations, {
    kind: "github-credential",
    step: "install",
    token: FAKE_TOKEN,
  });

  expect(installed).toEqual({ ok: true, result: { kind: "credential-installed" } });
  expect(operations.stdins[0]).toBe(`${FAKE_TOKEN}\n`);
});

test("reports a failed install without leaving anything to clean up", async () => {
  const operations = new FilesystemlessOperations();
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
});

test("reports an unavailable workspace when the install command cannot run", async () => {
  const operations = new FilesystemlessOperations();
  operations.commandFails = true;

  const failed = await credential(operations, {
    kind: "github-credential",
    step: "install",
    token: FAKE_TOKEN,
  });

  expect(failed).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
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
