import { expect, test } from "vitest";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import { HARNESS_BUILD_CONFIGURATION, planHarnessBuild } from "../../../src/harness-build.js";

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

function scriptCommand(name: string): string {
  const line = new RegExp(`^ {4}"${name}": "(.*)",?$`, "mu").exec(manifest);

  if (line === null) {
    throw new Error(`package.json defines no ${name} script`);
  }

  return line[1] ?? "";
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

test("the configured phases are, in order, what build:artifact runs locally", () => {
  const phases = HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.command);

  expect(
    scriptCommand("build:artifact"),
    "a developer, the clean-build probe and the deployed build must run the same work in the same order",
  ).toBe(phases.join(" && "));
  expect(phases[0], "a freshly extracted commit has no node_modules").toContain(
    "pnpm install --frozen-lockfile",
  );
  expect(phases[1], "esbuild cannot resolve Pi Durable before the install").toBe(
    "pnpm run build:module-map",
  );
});

const commit = testHarnessCommit("6000000000000000000000000000000000000003");

const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);

test("provisions the harness repository under a lock and refuses an unexpected origin", () => {
  const provision = plan.steps[0]?.source;

  expect(provision).toContain('exec 9>"$lock"\nflock 9');
  expect(provision).toContain(
    'git clone --filter=blob:none --depth=50 --single-branch "$expected_remote" "$staging"',
  );
  expect(provision).toContain(
    'actual_remote="$(git --git-dir="$git_dir" config --get-all remote.origin.url || true)"',
  );
  expect(provision).toContain('if test "$actual_remote" != "$expected_remote"; then');
});
