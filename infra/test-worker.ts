import { resolve } from "node:path";
import {
  assetsConfig,
  compatibility,
  durableObjectClasses,
  MODULE_MAPS_BINDING,
  plainTextBindings,
  PRODUCTION_STAGE,
  shellModulesAssetDirectory,
  workerEntrypoint,
} from "./worker-settings.js";

const CHALLENGE_LOG_HOST = "git-challenges.test";

const gitChallenges: { remote: string; authorization: string | null }[] = [];

export const testWorker = {
  main: `./${workerEntrypoint}`,
  miniflare: {
    compatibilityDate: compatibility.date,
    compatibilityFlags: [...compatibility.flags],
    bindings: { ...plainTextBindings(PRODUCTION_STAGE), OWNER_PASSWORD: "test-owner-password" },
    durableObjects: {
      SUPERVISOR: { className: durableObjectClasses.SUPERVISOR, useSQLite: true },
      WORKSPACE_HOST: { className: durableObjectClasses.WORKSPACE_HOST, useSQLite: true },
    },
    workerLoaders: { LOADER: {} },
    r2Buckets: [MODULE_MAPS_BINDING],
    outboundService: (request: Request) => {
      const { host, pathname } = new URL(request.url);

      if (host === CHALLENGE_LOG_HOST) return Response.json(gitChallenges);

      if (pathname.endsWith("/info/refs")) {
        const authorization = request.headers.get("authorization");

        gitChallenges.push({ remote: `${host}${pathname}`, authorization });

        return new Response(null, {
          status: authorization === null ? 401 : 404,
          headers: { "www-authenticate": 'Basic realm="private"' },
        });
      }

      return new Response(
        `tests have no outbound network: ${request.method} ${request.headers.get("content-type") ?? "no-type"} ${request.headers.get("authorization") ?? "anonymous"}`,
        {
          status: 503,
        },
      );
    },
    versionMetadata: "CF_VERSION_METADATA",
    assets: {
      directory: resolve(import.meta.dirname, "..", shellModulesAssetDirectory),
      binding: "ASSETS",
      routerConfig: { has_user_worker: true },
      run_worker_first: assetsConfig.runWorkerFirst,
    },
  },
};
