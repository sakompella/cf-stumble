import { expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../../src/harness-build.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const manifestFiles = import.meta.glob("../../../package.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

const manifest = Object.values(manifestFiles).at(0) ?? "";

function scriptNames(): readonly string[] {
  const start = manifest.indexOf('"scripts": {');
  const block = manifest.slice(start, manifest.indexOf("\n  },", start));

  return [...block.matchAll(/^ {4}"([^"]+)":/gmu)].map((match) => match[1] ?? "");
}

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
    expect(scriptNames(), `package.json must define ${script}`).toContain(script);
  }
});
