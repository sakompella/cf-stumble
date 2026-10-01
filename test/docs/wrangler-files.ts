import { isRecord } from "../../src/routes/json.js";

/**
 * The two Wrangler files, read as text. Vite resolves the glob at build time, so this reads no
 * filesystem and runs in workerd.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const configs = import.meta.glob("../../wrangler*.jsonc", {
  eager: true,
  query: "?raw",
  import: "default",
});

export function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .trim();
}

export function config(name: string): string {
  const found = Object.entries(configs).find(([path]) => path.endsWith(name));

  if (found === undefined) {
    throw new Error(`missing ${name}`);
  }

  return withoutComments(found[1]);
}

type WranglerContainer = Readonly<{ instance_type?: unknown }>;

export type WranglerConfig = Readonly<{
  cache?: Readonly<{ enabled?: boolean }>;
  containers?: readonly WranglerContainer[];
}>;

function isWranglerConfig(value: unknown): value is WranglerConfig {
  if (!isRecord(value)) return false;

  const cache = value.cache;
  const containers = value.containers;

  return (
    (cache === undefined ||
      (isRecord(cache) && (cache.enabled === undefined || typeof cache.enabled === "boolean"))) &&
    (containers === undefined ||
      (Array.isArray(containers) && containers.every((container) => isRecord(container))))
  );
}

export function parsedConfig(name: string): WranglerConfig {
  const json = config(name).replaceAll(/,\s*([}\]])/gu, "$1");
  const parsed: unknown = JSON.parse(json);

  if (!isWranglerConfig(parsed)) {
    throw new Error(`invalid ${name}`);
  }

  return parsed;
}
