import { expect, test } from "vitest";
import { orbCommands, type OrbPorts } from "../../../src/stumble-cli/orb/commands.js";
import { runCommandTree } from "../../../src/stumble-cli/tree.js";

function ports(platform: string, arch: string, lines: string[]): OrbPorts {
  return {
    env: {},
    signal: new AbortController().signal,
    log: (line) => {
      lines.push(line);
    },
    platform,
    arch,
  };
}

test.each([
  ["darwin", "arm64"],
  ["linux", "arm64"],
  ["win32", "x64"],
])("the provider warns on %s %s and carries on", async (platform, arch) => {
  const lines: string[] = [];

  const output = await runCommandTree(
    orbCommands,
    ["provider", "dispatch.sh"],
    ports(platform, arch, lines),
  );

  expect(lines).toContain(
    `warning: the orb provider is tested on x86_64 Linux only, not ${platform} ${arch}`,
  );
  expect(output.stderr).toBe("set STUMBLE_ORB_URL to the Worker's http(s) URL\n");
});

test("the provider does not warn on x86_64 Linux", async () => {
  const lines: string[] = [];

  await runCommandTree(orbCommands, ["provider", "dispatch.sh"], ports("linux", "x64", lines));

  expect(lines).toEqual([]);
});
