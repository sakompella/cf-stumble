import type { MainHarnessArtifactInput } from "../../../src/facet/artifact.js";

type BuiltModuleMapFile = Omit<MainHarnessArtifactInput, "harnessCommit">;

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

  return new Response(builtFile).json<BuiltModuleMapFile>();
}

export async function builtGeneration(harnessCommit: string): Promise<MainHarnessArtifactInput> {
  return { harnessCommit, ...(await builtModuleMap()) };
}
