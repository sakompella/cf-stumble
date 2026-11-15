import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { orbCommands } from "../../../src/stumble-cli/orb/commands.js";
import { runCommandTree } from "../../../src/stumble-cli/tree.js";

const other = gs.oneOf(
  gs.sampledFrom(["darwin", "win32", "freebsd", "arm64", "ia32"]),
  gs.fromRegex("[a-z0-9]{1,8}", { fullmatch: true }),
);

const platform = gs.oneOf(gs.just("linux"), other);

const arch = gs.oneOf(gs.just("x64"), other);

test("the provider warns about any platform other than x86_64 Linux, naming it, and still runs", async () => {
  await hegel.testAsync(async (tc) => {
    const drawnPlatform = tc.draw(platform);
    const drawnArch = tc.draw(arch);
    const lines: string[] = [];

    const output = await runCommandTree(orbCommands, ["provider", "dispatch.sh"], {
      env: {},
      signal: new AbortController().signal,
      log: (line) => {
        lines.push(line);
      },
      platform: drawnPlatform,
      arch: drawnArch,
    });

    const supported = drawnPlatform === "linux" && drawnArch === "x64";

    expect(lines.length).toBe(supported ? 0 : 1);
    expect(lines.every((line) => line.includes(`${drawnPlatform} ${drawnArch}`))).toBe(true);
    expect(output.stderr).toBe("set STUMBLE_ORB_URL to the Worker's http(s) URL\n");
  });
});
