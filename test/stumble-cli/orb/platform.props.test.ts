import { expect, test } from "vitest";
import { orbCommands, type OrbPorts } from "../../../src/stumble-cli/orb/commands.js";
import { runCommandTree } from "../../../src/stumble-cli/tree.js";

function ports(platform: string, arch: string): OrbPorts {
  return { env: {}, signal: new AbortController().signal, log: () => {}, platform, arch };
}

test.each([
  ["darwin", "arm64"],
  ["linux", "arm64"],
  ["win32", "x64"],
])("the provider refuses to start on %s %s", async (platform, arch) => {
  const output = await runCommandTree(
    orbCommands,
    ["provider", "dispatch.sh"],
    ports(platform, arch),
  );

  expect(output.stderr).toBe(
    `the orb provider supports x86_64 Linux only, not ${platform} ${arch}\n`,
  );
  expect(output.exitCode).toBe(1);
});
