import manifest from "@earendil-works/pi-durable/package.json" with { type: "json" };

export const FACET_COMPATIBILITY: string = `pi-durable@${manifest.version}/host-5`;

export const FACET_RUNTIME: Pick<
  WorkerLoaderWorkerCode,
  "compatibilityDate" | "compatibilityFlags"
> = {
  compatibilityDate: "2025-01-01",
  compatibilityFlags: ["enable_weak_ref", "expose_global_message_channel"],
};
