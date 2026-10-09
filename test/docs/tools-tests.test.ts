import { describe, expect, it } from "vitest";
import { isRecord } from "../../src/untrusted.js";

/**
 * Vitest runs `test/**` only. The vendored lint-rule tests under `tools/` use Oxlint's
 * RuleTester and a native Oxlint CLI run, so `pnpm test:tools` runs them with `node --test`
 * instead. Node exits 0 when its pattern matches no file, so a narrowed or stale pattern would
 * pass silently; this check ties the pattern to the files that exist and to `pnpm verify`.
 *
 * Vite resolves the globs at build time, so this reads no filesystem and runs in workerd.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const packageFiles = import.meta.glob("../../package.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

const toolTestFiles = Object.keys(
  import.meta.glob("../../tools/**/*.test.ts", { eager: true, query: "?raw", import: "default" }),
).map((path) => path.replace(/^\.\.\/\.\.\//u, ""));

type GateScripts = Readonly<{ verify: string; "test:tools": string }>;

function isGateScripts(value: unknown): value is GateScripts {
  return (
    isRecord(value) && typeof value.verify === "string" && typeof value["test:tools"] === "string"
  );
}

function gateScripts(): GateScripts {
  const source = Object.values(packageFiles)[0];
  const parsed: unknown = source === undefined ? undefined : JSON.parse(source);
  const scripts = isRecord(parsed) ? parsed.scripts : undefined;

  if (!isGateScripts(scripts)) {
    throw new TypeError("package.json lacks the verify or test:tools script");
  }

  return scripts;
}

/** Supports the `**` and `*` wildcards the tools runner uses, not full glob syntax. */
function globPattern(glob: string): RegExp {
  const escaped = glob.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const wildcards = escaped.replaceAll("**/", "\u0000").replaceAll("*", "[^/]*");

  return new RegExp(`^${wildcards.replaceAll("\u0000", "(?:.*/)?")}$`, "u");
}

describe("Node tools tests", () => {
  it("run as part of pnpm verify", () => {
    expect(gateScripts().verify.split(" && ")).toContain("pnpm test:tools");
  });

  it("match every test file under tools", () => {
    const runnerGlob = /^node --test '([^']+)'$/u.exec(gateScripts()["test:tools"])?.[1];

    expect(runnerGlob).toBeDefined();
    expect(toolTestFiles.length).toBeGreaterThan(0);

    const pattern = globPattern(runnerGlob ?? "");
    const missed = toolTestFiles.filter((path) => !pattern.test(path));

    expect(missed).toEqual([]);
  });
});
