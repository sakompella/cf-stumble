import * as Result from "effect/Result";
import { afterEach, expect, test, vi } from "vitest";
import { parseGitHubToken, REDACTED } from "../../src/github/index.js";
import {
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
} from "../../src/workspace/index.js";
import { textLines } from "../log-capture.js";
import { runToResult } from "./workspace-results.js";
import type { WorkspaceHostNamespace, WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

function namespaceOf(host: WorkspaceHostRpc<"credential">): WorkspaceHostNamespace<"credential"> {
  return { getByName: () => host };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("does not continue a credential step after its turn signal aborts", async () => {
  const controller = new AbortController();

  const host: WorkspaceHostRpc<"credential"> = {
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

test("a thrown install RPC fails as workspace-unavailable and logs its cause with the token redacted", async () => {
  const token = parseGitHubToken("ghp_cfstumbleFAKEtokenFAKEtoken0123456789");

  if (token === undefined) throw new Error("the test token must parse");

  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const installed = await runToResult(
    installWorkspaceCredential({
      workspaceName: "tenant-workspace",
      namespace: namespaceOf({
        credential: () => Promise.reject(new Error(`socket hang up while sending ${token}`)),
      }),
      token,
    }),
  );

  expect(Result.isFailure(installed) && installed.failure.code).toBe(
    "credential-workspace-unavailable",
  );

  const logged = textLines(errors).join("\n");

  expect(logged).toContain(REDACTED);
  expect(logged).not.toContain(token);
});
