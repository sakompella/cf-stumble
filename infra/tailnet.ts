import * as Cloudflare from "@alchemy.run/cloudflare";
import { compatibility, observability, PRODUCTION_STAGE } from "./worker-settings.js";

export function tailnetWorker(stage: string) {
  const isProduction = stage === PRODUCTION_STAGE;

  return Cloudflare.Worker("Tailnet", {
    name: isProduction ? "cf-stumble-tailnet" : `cf-stumble-tailnet-${stage}`,
    main: "src/tailnet-worker.ts",
    compatibility: { date: compatibility.date, flags: [...compatibility.flags] },
    workersDev: false,
    observability: observability(isProduction),
    env: {
      NODE: Cloudflare.DurableObject("TailnetObject"),
      TS_HOSTNAME: `cf-stumble-${stage}`,
    },
  });
}
