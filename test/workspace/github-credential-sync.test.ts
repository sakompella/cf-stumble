import type { ExecSyncResult } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { WorkspaceHost } from "../../src/workspace/host.js";
import type { GitHubCredentialRequest } from "../../src/workspace/github-credential.js";
import { restoreWorkspaceMembers, stubWorkspaceMember } from "./host-fixtures.js";

afterEach(restoreWorkspaceMembers);

const installRequest: GitHubCredentialRequest = {
  kind: "github-credential",
  step: "install",
  token: "ghp_cfstumbleFAKEtokenFAKEtoken0123456789",
};

function hostAnswering<T>(
  name: string,
  sync: ExecSyncResult,
  run: (host: WorkspaceHost, sources: readonly string[]) => Promise<T>,
): Promise<T> {
  const sources: string[] = [];

  const runtime = {
    exec: (source: string) => {
      sources.push(source);

      return Promise.resolve({
        result: () =>
          Promise.resolve({ stdout: "connected octocat\n", stderr: "", exitCode: 0, sync }),
      });
    },
  };

  stubWorkspaceMember("runtime", runtime);

  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    Object.defineProperty(state, "container", { value: {}, configurable: true });

    return run(new WorkspaceHost(state, { LOADER: env.LOADER }), sources);
  });
}

const complete: ExecSyncResult = { status: "complete", applied: 1, skipped: [] };

const pending: ExecSyncResult = {
  status: "pending",
  applied: 0,
  skipped: [],
  error: "pull failed",
};

test("the Host refuses an install whose workspace copy is still pending, and logs it out", async () => {
  const seen = await hostAnswering("credential-host-pending", pending, async (host, sources) => ({
    result: await host.credential(installRequest),
    sources,
  }));

  expect(seen.result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
  expect(seen.sources).toHaveLength(2);
  expect(seen.sources[0]).toContain("gh auth login");
  expect(seen.sources[1]).toContain("gh auth logout --hostname github.com");
});

test("the Host installs once the workspace copy is complete, and its status read needs no sync", async () => {
  const installed = await hostAnswering("credential-host-complete", complete, (host) =>
    host.credential(installRequest),
  );

  const status = await hostAnswering("credential-host-status", pending, (host) =>
    host.credential({ kind: "github-credential", step: "status" }),
  );

  expect(installed).toEqual({ ok: true, result: { kind: "credential-installed" } });
  expect(status).toEqual({
    ok: true,
    result: { kind: "credential-status", state: "connected", login: "octocat" },
  });
});
