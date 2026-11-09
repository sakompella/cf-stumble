import { resolve } from "node:path";
import {
  compatibility,
  durableObjectClasses,
  plainTextBindings,
  shellModulesAssetDirectory,
  workerEntrypoint,
} from "./worker-settings.js";

export const testWorker = {
  main: `./${workerEntrypoint}`,
  miniflare: {
    compatibilityDate: compatibility.date,
    compatibilityFlags: [...compatibility.flags],
    bindings: { ...plainTextBindings, OWNER_PASSWORD: "test-owner-password" },
    durableObjects: {
      SUPERVISOR: { className: durableObjectClasses.SUPERVISOR, useSQLite: true },
      WORKSPACE_HOST: { className: durableObjectClasses.WORKSPACE_HOST, useSQLite: true },
    },
    workerLoaders: { LOADER: {} },
    outboundService: (request: Request) =>
      new Response(
        `tests have no outbound network: ${request.headers.get("user-agent") ?? "none"} ${request.headers.get("authorization") ?? "anonymous"}`,
        {
          status: 503,
        },
      ),
    versionMetadata: "CF_VERSION_METADATA",
    assets: {
      directory: resolve(import.meta.dirname, "..", shellModulesAssetDirectory),
      binding: "ASSETS",
    },
  },
};
