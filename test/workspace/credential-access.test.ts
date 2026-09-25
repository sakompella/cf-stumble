import { afterEach, expect, test, vi } from "vitest";
import { parseGitHubToken, REDACTED, type GitHubToken } from "../../src/github/index.js";
import {
  checkRepositoryAccess,
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
  type CredentialWorkspaceHost,
  type CredentialWorkspaceNamespace,
  type GitHubCredentialRequest,
  type GitHubCredentialResult,
} from "../../src/workspace/index.js";

/**
 * The Supervisor's side of the credential RPC, driven against a Workspace Host binding that
 * throws instead of answering.
 *
 * `ask` in `credential-access.ts` is the boundary this file exercises: whatever a Workspace Host
 * throws (an RPC disconnect, a Durable Object eviction, a network failure) used to become
 * `credential-workspace-unavailable` with an empty detail and nothing else. The public problem
 * still carries no detail — that is unchanged — but the cause now reaches an operator log,
 * redacted, and a token this caller is holding never reaches it even when the thrown cause echoes
 * one back.
 */

function fakeToken(value: string): GitHubToken {
  const token = parseGitHubToken(value);

  if (token === undefined) {
    throw new Error("the test token must parse as a GitHubToken");
  }

  return token;
}

const FAKE_TOKEN = fakeToken("ghp_cfstumbleFAKEtokenFAKEtoken0123456789");

/** A Workspace Host binding whose `credential` RPC always rejects with a configured cause. */
class ThrowingWorkspaceHost implements CredentialWorkspaceHost {
  cause: Error = new Error("rpc session was shut down");

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the Workspace Host RPC boundary this test drives.
  credential(_request: GitHubCredentialRequest): Promise<GitHubCredentialResult> {
    return Promise.reject(this.cause);
  }
}

function namespaceOf(host: CredentialWorkspaceHost): CredentialWorkspaceNamespace {
  return { getByName: () => host };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("logs the thrown cause instead of discarding it, with the install token redacted", async () => {
  const host = new ThrowingWorkspaceHost();
  host.cause = new Error(`socket hang up while sending ${FAKE_TOKEN}`);
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const installed = await installWorkspaceCredential({
    workspaceName: "tenant-workspace",
    namespace: namespaceOf(host),
    token: FAKE_TOKEN,
  });

  expect(installed.isErr() && installed.error).toEqual({
    code: "credential-workspace-unavailable",
    detail: "",
  });
  expect(loggedErrors, "the discarded cause must reach an operator log").toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("credential-workspace-unavailable");
  expect(logged, "the install token must never reach the log").not.toContain(FAKE_TOKEN);
  expect(logged).toContain(REDACTED);
});

test("logs a status read's thrown cause the same way, without a token to redact", async () => {
  const host = new ThrowingWorkspaceHost();
  host.cause = new Error("websocket is not open");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const status = await readWorkspaceCredentialStatus({
    workspaceName: "tenant-workspace",
    namespace: namespaceOf(host),
  });

  expect(status.isErr() && status.error).toEqual({
    code: "credential-workspace-unavailable",
    detail: "",
  });
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("credential-access.status");
});

test("distinguishes a timeout from an ordinary RPC failure in the log alone", async () => {
  const host = new ThrowingWorkspaceHost();
  host.cause = new DOMException("the RPC call exceeded its budget", "TimeoutError");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const access = await checkRepositoryAccess({
    workspaceName: "tenant-workspace",
    namespace: namespaceOf(host),
    repositoryUrl: "https://github.com/owner/repo",
  });

  expect(access.isErr() && access.error).toEqual({
    code: "credential-workspace-unavailable",
    detail: "",
  });
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged, "a timeout is distinguishable in the log even though the code is not").toContain(
    "timeout",
  );
});
