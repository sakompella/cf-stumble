import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { parseGitHubToken } from "../../src/github/index.js";
import { installWorkspaceCredential } from "../../src/workspace/index.js";
import { capturedEvents, everythingLogged } from "../log-capture.js";
import { runToResult } from "./workspace-results.js";
import type { WorkspaceHostNamespace, WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

function namespaceOf(host: WorkspaceHostRpc<"credential">): WorkspaceHostNamespace<"credential"> {
  return { getByName: () => host };
}

test("a thrown install RPC fails as workspace-unavailable and never logs the token", async () => {
  const token = parseGitHubToken("ghp_cfstumbleFAKEtokenFAKEtoken0123456789");

  if (token === undefined) throw new Error("the test token must parse");

  capturedEvents();

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
  expect(everythingLogged()).not.toContain(token);
});
