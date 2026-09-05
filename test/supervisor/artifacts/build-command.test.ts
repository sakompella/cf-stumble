import { expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../../src/harness-build.js";

/**
 * The Supervisor's build command and the local gate used to be two different commands. The
 * deployed build ran `pnpm run build:module-map` in a freshly extracted commit, which has no
 * `node_modules` and no generated Pi output, while `pnpm verify` built Pi first and never saw the
 * failure. These checks keep the two from drifting apart again: the configured command must name
 * a script this manifest defines, and that script must install from the lockfile and build Pi
 * before it builds the module map.
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

test("the configured build command names a script this repository defines", () => {
  const named = /^pnpm run (?<script>[\w:-]+)$/u.exec(HARNESS_BUILD_CONFIGURATION.buildCommand);
  expect(named, "the build command must name one script, not spell out a command line").not.toBe(
    null,
  );

  const script = named?.groups?.["script"] ?? "";
  expect(scriptNames(), `package.json must define ${script}`).toContain(script);
});

test("the build script installs from the lockfile and builds Pi before the module map", () => {
  const command = scriptCommand("build:artifact");
  const install = command.indexOf("pnpm install --frozen-lockfile");
  const buildPi = command.indexOf("build:pi");
  const buildModuleMap = command.indexOf("build:module-map");

  expect(install, "a freshly extracted commit has no node_modules").toBeGreaterThanOrEqual(0);
  expect(buildPi, "a freshly extracted commit has no vendor/pi-v0.84.4/dist").toBeGreaterThan(
    install,
  );
  expect(
    buildModuleMap,
    "esbuild cannot resolve @cf-stumble/pi before Pi is built",
  ).toBeGreaterThan(buildPi);
});

test("the clean-build probe stays committed and runnable", () => {
  expect(
    Object.keys(probeFiles),
    "scripts/probe/clean-build.sh is the only proof that a clean checkout still builds",
  ).toHaveLength(1);
  expect(scriptCommand("probe:clean-build")).toBe("scripts/probe/clean-build.sh");
  expect(Object.values(probeFiles).at(0) ?? "").toContain("build:artifact");
});
