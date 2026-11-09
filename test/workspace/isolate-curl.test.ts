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
    const project = await host.project({ remainingMs: 60_000 });

    if (hosts !== "")
      await project.writeFile(HOSTS_YML, new TextEncoder().encode(hosts), "overwrite");

    const started = await project.startExec({ command, timeoutMs: 10_000 });

    if (!started.ok) throw new Error(started.error.code);

    return linesOf(started.value.events);
  });
}

test("curl in the isolate fetches any host through the gateway", async () => {
  const lines = await runCurl("isolate-curl-any-host", "curl https://example.com/");

  expect(lines.join("\n")).toContain("tests have no outbound network: GET no-type anonymous");
  expect(lines.at(-1)).toContain('"outcome":"exited"');
  expect(lines.at(-1)).toContain('"exitCode":0');
});

test("curl in the isolate posts with a body and its headers through the gateway", async () => {
  const lines = await runCurl("isolate-curl-post", "curl -X POST -d 'a=b' https://example.com/api");

  expect(lines.join("\n")).toContain(
    "tests have no outbound network: POST application/x-www-form-urlencoded anonymous",
  );
  expect(lines.at(-1)).toContain('"exitCode":0');
});

test("curl to api.github.com in the isolate carries the workspace's GitHub token", async () => {
  const lines = await runCurl(
    "isolate-curl-github-token",
    "curl https://api.github.com/repos/owner/repo",
    "github.com:\n    oauth_token: ghp_cfstumbleFAKEtokenFAKEtoken0123456789\n",
  );

  expect(lines.join("\n")).toContain(
    "tests have no outbound network: GET no-type Bearer ghp_cfstumbleFAKEtokenFAKEtoken0123456789",
  );
});

test("curl to a host other than api.github.com never carries the GitHub token", async () => {
  const lines = await runCurl(
    "isolate-curl-no-token-off-api",
    "curl https://github.com/owner/repo",
    "github.com:\n    oauth_token: ghp_cfstumbleFAKEtokenFAKEtoken0123456789\n",
  );

  expect(lines.join("\n")).toContain("tests have no outbound network: GET no-type anonymous");
});

test("curl to api.github.com without a stored token goes out unauthenticated", async () => {
  const lines = await runCurl(
    "isolate-curl-no-token",
    "curl https://api.github.com/repos/owner/repo",
  );

  expect(lines.join("\n")).toContain("tests have no outbound network: GET no-type anonymous");
});
