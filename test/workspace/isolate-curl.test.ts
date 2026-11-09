import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { seedWorkspaceRoot } from "./host-fixtures.js";

const HOSTS_YML = `/.config/gh/hosts.yml`;

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await new Response(stream).text();

  return text.split("\n").filter((line) => line !== "");
}

function runCurl(name: string, command: string, hosts = "") {
  return runInDurableObject(env.WORKSPACE_HOST.getByName(name), async (host, state) => {
    await seedWorkspaceRoot(state);
    const project = host.project({ remainingMs: 60_000 });

    if (hosts !== "")
      await project.writeFile(HOSTS_YML, new TextEncoder().encode(hosts), "overwrite");

    const started = await project.startExec({ command, timeoutMs: 10_000 });

    if (!started.ok) throw new Error(started.error.code);

    return linesOf(started.value.events);
  });
}

test("curl in the isolate fetches an allowed host through the gateway", async () => {
  const lines = await runCurl("isolate-curl-allowed", "curl https://github.com/owner/repo");

  expect(lines.join("\n")).toContain("tests have no outbound network: cf-stumble-isolate");
  expect(lines.at(-1)).toContain('"outcome":"exited"');
  expect(lines.at(-1)).toContain('"exitCode":0');
});

test("curl in the isolate is refused for a host outside the allowlist", async () => {
  const lines = await runCurl("isolate-curl-refused", "curl https://example.com/");

  expect(lines.join("\n")).toContain("is not an allowed host");
  expect(lines.at(-1)).toContain('"exitCode":0');
});

test("curl to api.github.com in the isolate carries the workspace's GitHub token", async () => {
  const lines = await runCurl(
    "isolate-curl-github-token",
    "curl https://api.github.com/repos/owner/repo",
    "github.com:\n    oauth_token: ghp_cfstumbleFAKEtokenFAKEtoken0123456789\n",
  );

  expect(lines.join("\n")).toContain(
    "tests have no outbound network: cf-stumble-isolate Bearer ghp_cfstumbleFAKEtokenFAKEtoken0123456789",
  );
});

test("curl to a host other than api.github.com never carries the GitHub token", async () => {
  const lines = await runCurl(
    "isolate-curl-no-token-off-api",
    "curl https://github.com/owner/repo",
    "github.com:\n    oauth_token: ghp_cfstumbleFAKEtokenFAKEtoken0123456789\n",
  );

  expect(lines.join("\n")).toContain(
    "tests have no outbound network: cf-stumble-isolate anonymous",
  );
});

test("curl to api.github.com without a stored token goes out unauthenticated", async () => {
  const lines = await runCurl(
    "isolate-curl-no-token",
    "curl https://api.github.com/repos/owner/repo",
  );

  expect(lines.join("\n")).toContain(
    "tests have no outbound network: cf-stumble-isolate anonymous",
  );
});
