import * as Result from "effect/Result";
import { parseHarnessCommit } from "../../../src/harness-commit.js";
import { moduleMapFromBuildOutput } from "../../../src/supervisor/artifacts/index.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/index.js";
import type { BuiltModuleMapFile } from "../../../src/supervisor/artifacts/index.js";

/**
 * `pnpm build:module-map` writes this file, and `pnpm verify` runs that build before the tests.
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

const builtFile = Object.values(
  import.meta.glob("../../../build/module-map.json", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
).at(0);

export function builtModuleMap(): Promise<BuiltModuleMapFile> {
  if (builtFile === undefined) throw new Error("run pnpm build:module-map before the tests");

  // `Response.json` decodes the build output without asserting a shape it has not proved yet.
  return new Response(builtFile).json<BuiltModuleMapFile>();
}

/** The built generation 1 as the Supervisor's build path would store it under `commit`. */
export async function builtGeneration(commit: string): Promise<MainHarnessArtifactInput> {
  const harnessCommit = parseHarnessCommit(commit);

  if (harnessCommit === undefined) throw new Error("the test commit must be a Git object ID");
  const validated = moduleMapFromBuildOutput(harnessCommit, await builtModuleMap());

  if (Result.isFailure(validated)) {
    throw new Error(`the built module map must validate: ${validated.failure.code}`);
  }

  return validated.success;
}
