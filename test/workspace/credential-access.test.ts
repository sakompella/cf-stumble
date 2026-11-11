import * as Result from "effect/Result";
import { afterEach, expect, test, vi } from "vitest";
import { parseGitHubToken } from "../../src/github/index.js";
import { REDACTED } from "../../src/github/redaction.js";
import { installWorkspaceCredential } from "../../src/workspace/index.js";
import { textLines } from "../log-capture.js";
import { runToResult } from "./workspace-results.js";
import type { WorkspaceHostNamespace, WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

function namespaceOf(host: WorkspaceHostRpc<"credential">): WorkspaceHostNamespace<"credential"> {
  return { getByName: () => host };
}

afterEach(() => {
  vi.restoreAllMocks();
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
