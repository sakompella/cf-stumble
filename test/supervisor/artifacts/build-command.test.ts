import { expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../../src/harness-build.js";
import manifest from "../../../package.json";

const scriptNames = Object.keys(manifest.scripts);

test("every configured build phase names a script this repository defines", () => {
  for (const phase of HARNESS_BUILD_CONFIGURATION.buildPhases) {
    if (/^pnpm install(?: --[\w-]+(?:=[\w-]+)?)+$/u.test(phase.command)) {
      continue;
    }

    const named = /^pnpm run (?<script>[\w:-]+)$/u.exec(phase.command);
    expect(
      named,
      `the ${phase.name} phase must name one script or install with flags only, not spell out a command line`,
    ).not.toBe(null);
    const script = named?.groups?.["script"] ?? "";
    expect(scriptNames, `package.json must define ${script}`).toContain(script);
  }
});
