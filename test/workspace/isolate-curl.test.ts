import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { seedWorkspaceRoot } from "./host-fixtures.js";

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await new Response(stream).text();

  return text.split("\n").filter((line) => line !== "");
}

function runCurl(name: string, command: string) {
  return runInDurableObject(env.WORKSPACE_HOST.getByName(name), async (host, state) => {
    await seedWorkspaceRoot(state);
    const project = host.project({ remainingMs: 60_000 });

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
