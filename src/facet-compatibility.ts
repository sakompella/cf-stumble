import manifest from "@earendil-works/pi-durable/package.json" with { type: "json" };

export const FACET_COMPATIBILITY: string = `pi-durable@${manifest.version}/host-5`;
