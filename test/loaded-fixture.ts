import { env } from "cloudflare:workers";
import { FACET_RUNTIME } from "../src/facet/runtime-contract.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const builtFixtures = import.meta.glob("../build/loaded-*-fixture.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

interface BuiltFixtureFile {
  readonly entryModule: string;
  readonly modules: readonly { readonly name: string; readonly source: string }[];
}

function moduleEntry(module: BuiltFixtureFile["modules"][number]): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

export async function loadFixtureEntrypoint<T extends Rpc.WorkerEntrypointBranded>(
  fileName: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<Fetcher<T>> {
  const found = Object.entries(builtFixtures).find(([path]) => path.endsWith(fileName));

  if (found === undefined) {
    throw new Error(`missing ${fileName}; run pnpm build:loaded-execution-env-fixture`);
  }

  const fixture = await new Response(found[1]).json<BuiltFixtureFile>();

  const worker = env.LOADER.load({
    compatibilityDate: FACET_RUNTIME.compatibilityDate,
    mainModule: fixture.entryModule,
    modules: Object.fromEntries(fixture.modules.map(moduleEntry)),
    env: environment,
    globalOutbound: null,
  });

  return worker.getEntrypoint<T>();
}
