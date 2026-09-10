import { expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../../src/harness-build.js";

/**
 * The Supervisor's build and the local gate used to be two different commands. The deployed build
 * ran `pnpm run build:module-map` in a freshly extracted commit, which has no `node_modules` and
 * no generated Pi output, while `pnpm verify` built Pi first and never saw the failure. These
 * checks keep the two from drifting apart again, now that the deployed build runs its phases as
 * separate steps and `build:artifact` is what a developer and the clean-build probe run: every
 * phase command must name a script this manifest defines or be a flag-only `pnpm install`, and
 * the phases in order must be exactly what `build:artifact` runs.
 *
 * Vite resolves the glob at build time, so this reads no filesystem and runs in workerd.
 */
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

const probeFiles = import.meta.glob("../../../scripts/probe/clean-build.sh", {
  eager: true,
  query: "?raw",
  import: "default",
});

const manifest = Object.values(manifestFiles).at(0) ?? "";

/** The script names `package.json` defines, read from the manifest text rather than parsed. */
function scriptNames(): readonly string[] {
  const start = manifest.indexOf('"scripts": {');
  const block = manifest.slice(start, manifest.indexOf("\n  },", start));
  return [...block.matchAll(/^ {4}"([^"]+)":/gmu)].map((match) => match[1] ?? "");
}

/** The command line `package.json` gives one script name. */
function scriptCommand(name: string): string {
  const line = new RegExp(`^ {4}"${name}": "(.*)",?$`, "mu").exec(manifest);
  if (line === null) {
    throw new Error(`package.json defines no ${name} script`);
  }

  return line[1] ?? "";
}

test("reads the package manifest and its script names", () => {
  expect(scriptNames()).toContain("verify");
  expect(scriptCommand("build:module-map")).toBe("pnpm exec tsx tools/build-generation-0.mts");
});

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

test("the configured phases are, in order, what build:artifact runs locally", () => {
  const phases = HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.command);

  expect(
    scriptCommand("build:artifact"),
    "a developer, the clean-build probe and the deployed build must run the same work in the same order",
  ).toBe(phases.join(" && "));
  expect(phases[0], "a freshly extracted commit has no node_modules").toContain(
    "pnpm install --frozen-lockfile",
  );
  expect(phases[1], "a freshly extracted commit has no vendor/pi-v0.84.4/dist").toBe(
    "pnpm run build:pi",
  );
  expect(phases[2], "esbuild cannot resolve @cf-stumble/pi before Pi is built").toBe(
    "pnpm run build:module-map",
  );
});

test("the clean-build probe stays committed and runnable", () => {
  expect(
    Object.keys(probeFiles),
    "scripts/probe/clean-build.sh is the only proof that a clean checkout still builds",
  ).toHaveLength(1);
  expect(scriptCommand("probe:clean-build")).toBe("scripts/probe/clean-build.sh");
  expect(Object.values(probeFiles).at(0) ?? "").toContain("build:artifact");
});
