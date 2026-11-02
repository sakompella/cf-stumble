import * as Result from "effect/Result";
import { expect, test } from "vitest";
import {
  readWorkspaceCredentialStatus,
  type CredentialWorkspaceNamespace,
} from "../../src/workspace/index.js";
import type { CredentialWorkspaceHost } from "../../src/workspace/credential-access.js";
import { runToResult } from "./workspace-results.js";

function namespaceOf(host: CredentialWorkspaceHost): CredentialWorkspaceNamespace {
  return { getByName: () => host };
}

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
