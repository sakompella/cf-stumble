import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { workerAssetDirectory } from "../../infra/worker-settings.ts";
import type { PageAssets } from "../../src/routes/page.js";

const ASSET_DIRECTORY = resolve(import.meta.dirname, "..", "..", workerAssetDirectory);

export const diskAssets: PageAssets = {
  fetch: async (request) => {
    const path = join(ASSET_DIRECTORY, new URL(request.url).pathname);

    return path.startsWith(ASSET_DIRECTORY) && existsSync(path)
      ? new Response(await readFile(path))
      : new Response(null, { status: 404 });
  },
};
