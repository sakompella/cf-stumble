import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { REDACTED } from "../../src/github/redaction.js";
import {
  checkGitHubRepositoryAccess,
  installGitHubCredential,
  readGitHubCredentialStatus,
} from "../../src/workspace/github-credential.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type CommandOutput,
  type WorkspacePathKind,
} from "./promise-operations.js";

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

const SAMPLE_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJl";

class FilesystemlessOperations implements PromiseOperations {
  readonly sources: string[] = [];
  readonly stdins: (string | undefined)[] = [];
  stdout = "";
  stderr = "";
  exitCode = 0;
  commandFailure: Error | undefined;

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
    if (this.commandFailure !== undefined) return Promise.reject(this.commandFailure);
    this.sources.push(source);
    this.stdins.push(stdin);

    return Promise.resolve({ stdout: this.stdout, stderr: this.stderr, exitCode: this.exitCode });
  }
}

function install(operations: FilesystemlessOperations, token = FAKE_TOKEN) {
  return Effect.runPromise(
    installGitHubCredential(
      { lenient: workspaceEffects(operations), durable: workspaceEffects(operations) },
      token,
    ),
  );
}

function status(operations: FilesystemlessOperations) {
  return Effect.runPromise(readGitHubCredentialStatus(workspaceEffects(operations)));
}

function verify(operations: FilesystemlessOperations, repositoryUrl: string) {
  return Effect.runPromise(
    checkGitHubRepositoryAccess(workspaceEffects(operations), repositoryUrl),
  );
}

test("installs a credential in a workspace whose filesystem refuses everything, which staged the token in a /tmp the workspace filesystem does not have before d7f1481c", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = "connected octocat";

  await expect(install(operations)).resolves.toEqual({
    ok: true,
    status: { state: "connected", login: "octocat" },
  });
  expect(operations.stdins, "standard input is how gh reads the token").toEqual([
    `${FAKE_TOKEN}\n`,
  ]);
  expect(operations.sources.join("\n"), "the token is never part of a command line").not.toContain(
    FAKE_TOKEN,
  );
});

test("reports a failed install with gh's stderr as the detail", async () => {
  const operations = new FilesystemlessOperations();
  operations.exitCode = 1;
  operations.stderr = "gh: something went wrong";

  await expect(install(operations)).resolves.toEqual({
    ok: false,
    error: { code: "credential-command-failed", detail: "gh: something went wrong" },
  });
});

test("a command that cannot run is one workspace-unavailable failure", async () => {
  const operations = new FilesystemlessOperations();
  operations.commandFailure = new Error("workspace transport dropped");

  await expect(install(operations)).resolves.toEqual({
    ok: false,
    error: { code: "workspace-unavailable", detail: "" },
  });
});

test("redacts the installed token from a failure detail, even an opaque token with no known prefix", async () => {
  const opaqueToken = "s3cr3t-opaque-installer-token-0123456789";
  const operations = new FilesystemlessOperations();
  operations.exitCode = 1;
  operations.stderr = `gh: unexpected response, saw token ${opaqueToken} in the request`;

  await expect(install(operations, opaqueToken)).resolves.toEqual({
    ok: false,
    error: {
      code: "credential-command-failed",
      detail: `gh: unexpected response, saw token ${REDACTED} in the request`,
    },
  });
});

test("reports a workspace image without gh instead of pretending to install", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = "tooling-missing";

  await expect(install(operations)).resolves.toEqual({
    ok: true,
    status: { state: "tooling-missing" },
  });
});

test("an install answers the status the same command observed after the login", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = "unusable";

  await expect(install(operations)).resolves.toEqual({ ok: true, status: { state: "unusable" } });
  expect(operations.sources).toHaveLength(1);
});

test("an install whose observation reaches no verdict is a workspace-unavailable failure", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = "unreachable";

  await expect(install(operations)).resolves.toEqual({
    ok: false,
    error: { code: "workspace-unavailable", detail: "" },
  });
});

test.each([
  ["connected octocat", { state: "connected", login: "octocat" }],
  ["missing", { state: "missing" }],
  ["unusable", { state: "unusable" }],
  ["tooling-missing", { state: "tooling-missing" }],
])("reads %j as the credential status", async (stdout, expected) => {
  const operations = new FilesystemlessOperations();
  operations.stdout = stdout;

  await expect(status(operations)).resolves.toEqual({ ok: true, status: expected });
});

test.each(["something unexpected", "", "unreachable"])(
  "an unknown status output (%j) is a workspace-unavailable failure, not a verdict",
  async (stdout) => {
    const operations = new FilesystemlessOperations();
    operations.stdout = stdout;

    await expect(status(operations)).resolves.toEqual({
      ok: false,
      error: { code: "workspace-unavailable", detail: "" },
    });
  },
);

test("checks one repository for both spellings of its URL", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = "granted";

  const answers = [
    await verify(operations, "https://github.com/owner/repo.git"),
    await verify(operations, "https://github.com/owner/repo"),
  ];

  expect(answers).toEqual(
    Array.from({ length: 2 }, () => ({
      ok: true,
      access: { granted: true },
    })),
  );
  expect(operations.sources[0]).toBe(operations.sources[1]);
});

test("a repository git cannot read is denied with git's reason, secrets redacted", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = `denied fatal: could not read from https://user:${FAKE_TOKEN}@github.com/o/r ${SAMPLE_JWT}`;

  const refused = await verify(operations, "https://github.com/owner/repo");

  if (!refused.ok || refused.access.granted) {
    throw new Error("a denied repository must still be a result");
  }

  expect(refused.access.detail).toContain("could not read from");
  expect(refused.access.detail).not.toContain(FAKE_TOKEN);
  expect(refused.access.detail).not.toContain(SAMPLE_JWT);
});

test("refuses an install token or repository URL that does not parse, and runs nothing", async () => {
  const operations = new FilesystemlessOperations();
  const invalid = { ok: false, error: { code: "invalid-request", detail: "" } };

  await expect(install(operations, "has space")).resolves.toEqual(invalid);
  await expect(verify(operations, "git@github.com:o/r")).resolves.toEqual(invalid);

  expect(operations.sources).toEqual([]);
});
