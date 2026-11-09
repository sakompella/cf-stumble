import { Workspace } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { computerStorage } from "../../src/workspace/workspace-platform.js";
import { workspaceGit } from "../../src/workspace/project/index.js";

const SENTINEL = "ghp_sentinelTokenMustNeverLeak0123456789";

const SENTINEL_BASIC = `Basic ${btoa(`x-access-token:${SENTINEL}`)}`;

const Challenges = Schema.Array(
  Schema.Struct({ remote: Schema.String, authorization: Schema.NullOr(Schema.String) }),
);

async function authorizationsSeenBy(remote: string): Promise<readonly (string | null)[]> {
  const response = await fetch("http://git-challenges.test/");

  return Schema.decodeUnknownSync(Challenges)(await response.json())
    .filter((entry) => entry.remote === remote)
    .map((entry) => entry.authorization);
}

function inWorkspace(name: string, run: (workspace: Workspace) => Promise<void>) {
  return runInDurableObject(env.WORKSPACE_HOST.getByName(name), async (_host, state) => {
    const workspace = new Workspace({
      storage: computerStorage(state.storage),
      sessionId: state.id.toString(),
      backends: [],
      git: workspaceGit,
    });

    await workspace.fs.mkdir("/workspace/.config/gh", { recursive: true });
    await workspace.fs.writeFile(
      "/workspace/.config/gh/hosts.yml",
      `github.com:\n    oauth_token: ${SENTINEL}\n`,
    );
    await workspace.fs.mkdir("/repo");
    await workspace.git.init({ dir: "/repo" });
    await run(workspace);
  });
}

test("a non-GitHub remote that challenges for credentials receives no token", async () => {
  await inWorkspace("git-auth-foreign", async ({ git }) => {
    await expect(
      git.fetch({ dir: "/repo", url: "http://git.example.test/private.git" }),
    ).rejects.toThrow(/401/u);
    await expect(
      git.clone({ dir: "/clone", url: "http://git.example.test/private.git" }),
    ).rejects.toThrow(/401/u);
  });

  const seen = await authorizationsSeenBy("git.example.test/private.git/info/refs");

  expect(seen.length).toBeGreaterThan(1);
  expect(seen.every((authorization) => authorization === null)).toBe(true);
});

test("a github.com remote that challenges for credentials receives the token", async () => {
  await inWorkspace("git-auth-github", async ({ git }) => {
    await expect(
      git.fetch({ dir: "/repo", url: "https://github.com/owner/git-remote-auth.git" }),
    ).rejects.toThrow(/404/u);
  });

  expect(await authorizationsSeenBy("github.com/owner/git-remote-auth.git/info/refs")).toEqual([
    null,
    SENTINEL_BASIC,
  ]);
});
