/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";

/**
 * Loads one of the test-only Worker Loader entrypoints that
 * `tools/build-loaded-execution-env-fixture.mts` bundles into `build/`. `pnpm verify` runs that
 * build before the tests, which is what puts the files in place.
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

/** Loads one bundled entrypoint into its own Worker Loader isolate and returns a stub for it. */
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
    compatibilityDate: "2025-01-01",
    mainModule: fixture.entryModule,
    modules: Object.fromEntries(fixture.modules.map(moduleEntry)),
    env: environment,
    globalOutbound: null,
  });

  return worker.getEntrypoint<T>();
}
