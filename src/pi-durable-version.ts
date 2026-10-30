import manifest from "@earendil-works/pi-durable/package.json" with { type: "json" };

/**
 * The Pi Durable this code was built with. The Supervisor's storage and every generation it
 * attaches must agree on it exactly, because the storage schema and record kinds are a contract
 * between them.
 */
export const PI_DURABLE_VERSION: string = manifest.version;
