import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { REDACTED } from "../../src/github/redaction.js";
import {
  executeGitHubCredentialRequest,
  type GitHubCredentialRequest,
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

function credential(operations: FilesystemlessOperations, request: GitHubCredentialRequest) {
  return Effect.runPromise(
    executeGitHubCredentialRequest({
      operations: workspaceEffects(operations),
      installOperations: workspaceEffects(operations),
      request,
    }),
  );
}

function install(operations: FilesystemlessOperations, token = FAKE_TOKEN) {
  return credential(operations, { kind: "github-credential", step: "install", token });
}

test("installs a credential in a workspace whose filesystem refuses everything, which staged the token in a /tmp the workspace filesystem does not have before d7f1481c", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = "installed";

  await expect(install(operations)).resolves.toEqual({
    ok: true,
    result: { kind: "credential-installed" },
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
    result: { kind: "credential-status", state: "tooling-missing", login: undefined },
  });
});

test.each([
  ["connected octocat", "connected", "octocat"],
  ["missing", "missing", undefined],
  ["unusable", "unusable", undefined],
  ["tooling-missing", "tooling-missing", undefined],
  ["something unexpected", "unusable", undefined],
])("reads %j as the %s credential state", async (stdout, state, login) => {
  const operations = new FilesystemlessOperations();
  operations.stdout = stdout;

  await expect(
    credential(operations, { kind: "github-credential", step: "status" }),
  ).resolves.toEqual({ ok: true, result: { kind: "credential-status", state, login } });
});

function verify(operations: FilesystemlessOperations, repositoryUrl: string) {
  return credential(operations, {
    kind: "github-credential",
    step: "verify-repository",
    repositoryUrl,
  });
}

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
      result: { kind: "repository-access", granted: true, detail: "" },
    })),
  );
  expect(operations.sources[0]).toBe(operations.sources[1]);
});

test("a repository git cannot read is denied with git's reason, secrets redacted", async () => {
  const operations = new FilesystemlessOperations();
  operations.stdout = `denied fatal: could not read from https://user:${FAKE_TOKEN}@github.com/o/r ${SAMPLE_JWT}`;

  const refused = await verify(operations, "https://github.com/owner/repo");

  if (!refused.ok || refused.result.kind !== "repository-access") {
    throw new Error("a denied repository must still be a result");
  }

  expect(refused.result.granted).toBe(false);
  expect(refused.result.detail).toContain("could not read from");
  expect(refused.result.detail).not.toContain(FAKE_TOKEN);
  expect(refused.result.detail).not.toContain(SAMPLE_JWT);
});

test("refuses an install token or repository URL that does not parse, and runs nothing", async () => {
  const operations = new FilesystemlessOperations();

  for (const request of [
    { kind: "github-credential", step: "install", token: "has space" },
    { kind: "github-credential", step: "verify-repository", repositoryUrl: "git@github.com:o/r" },
  ] as const) {
    await expect(credential(operations, request)).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request", detail: "" },
    });
  }

  expect(operations.sources).toEqual([]);
});
