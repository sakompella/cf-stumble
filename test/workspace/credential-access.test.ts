import type * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { afterEach, expect, test, vi } from "vitest";
import { capturedEvents, everythingLogged, textLines } from "../log-capture.js";
import { parseGitHubToken, type GitHubToken } from "../../src/github/index.js";
import {
  checkRepositoryAccess,
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
  type CredentialWorkspaceNamespace,
} from "../../src/workspace/index.js";
import type { CredentialWorkspaceHost } from "../../src/workspace/credential-access.js";
import type {
  GitHubCredentialRequest,
  GitHubCredentialResult,
} from "../../src/workspace/github-credential.js";
import { plainProblem, runToResult } from "./workspace-results.js";

function fakeToken(value: string): GitHubToken {
  const token = parseGitHubToken(value);

  if (token === undefined) {
    throw new Error("the test token must parse as a GitHubToken");
  }

  return token;
}

const FAKE_TOKEN = fakeToken("ghp_cfstumbleFAKEtokenFAKEtoken0123456789");

class ThrowingWorkspaceHost implements CredentialWorkspaceHost {
  cause: Error = new Error("rpc session was shut down");

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

type CredentialStep = (
  namespace: CredentialWorkspaceNamespace,
) => Effect.Effect<unknown, Readonly<{ code: string }>>;

const credentialSteps: readonly (readonly [string, CredentialStep])[] = [
  [
    "install",
    (namespace: CredentialWorkspaceNamespace) =>
      installWorkspaceCredential({
        workspaceName: "tenant-workspace",
        namespace,
        token: FAKE_TOKEN,
      }),
  ],
  [
    "status",
    (namespace: CredentialWorkspaceNamespace) =>
      readWorkspaceCredentialStatus({ workspaceName: "tenant-workspace", namespace }),
  ],
  [
    "repository access",
    (namespace: CredentialWorkspaceNamespace) =>
      checkRepositoryAccess({
        workspaceName: "tenant-workspace",
        namespace,
        repositoryUrl: "https://github.com/owner/repo",
      }),
  ],
];

test.each(credentialSteps)(
  "a %s step whose RPC throws is unavailable, and its logged cause carries no token",
  async (_name, step) => {
    const host = new ThrowingWorkspaceHost();
    host.cause = new Error(`socket hang up while sending ${FAKE_TOKEN}`);
    capturedEvents();

    const outcome = await runToResult(step(namespaceOf(host)));

    expect(Result.isFailure(outcome) && plainProblem(outcome.failure)).toEqual({
      code: "credential-workspace-unavailable",
      detail: "",
    });
    expect(everythingLogged(), "the cause must still reach an operator log").toContain(
      "socket hang up",
    );
    expect(everythingLogged(), "no token may reach any log").not.toContain(FAKE_TOKEN);
  },
);

test("distinguishes a timeout from an ordinary RPC failure in the log alone", async () => {
  const host = new ThrowingWorkspaceHost();
  host.cause = new DOMException("the RPC call exceeded its budget", "TimeoutError");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const access = await runToResult(
    checkRepositoryAccess({
      workspaceName: "tenant-workspace",
      namespace: namespaceOf(host),
      repositoryUrl: "https://github.com/owner/repo",
    }),
  );

  expect(Result.isFailure(access) && plainProblem(access.failure)).toEqual({
    code: "credential-workspace-unavailable",
    detail: "",
  });
  const logged = textLines(loggedErrors)[0] ?? "";
  expect(logged, "a timeout is distinguishable in the log even though the code is not").toContain(
    "timeout",
  );
});

test("does not continue a credential step after its turn signal aborts", async () => {
  const controller = new AbortController();

  const host: CredentialWorkspaceHost = {
    credential: () => {
      controller.abort();

      return Promise.resolve({
        ok: true as const,
        result: {
          kind: "credential-status" as const,
          state: "connected" as const,
          login: "octocat",
        },
      });
    },
  };

  const status = await runToResult(
    readWorkspaceCredentialStatus({
      workspaceName: "tenant-workspace",
      namespace: namespaceOf(host),
      signal: controller.signal,
    }),
  );

  expect(Result.isFailure(status) && status.failure.code).toBe("credential-workspace-unavailable");
});
