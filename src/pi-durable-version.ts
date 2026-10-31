import manifest from "@earendil-works/pi-durable/package.json" with { type: "json" };

export const PI_DURABLE_VERSION: string = manifest.version;
