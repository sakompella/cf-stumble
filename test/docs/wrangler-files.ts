import * as Schema from "effect/Schema";

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

export function config(name: string): string {
  const found = Object.entries(configs).find(([path]) => path.endsWith(name));

  if (found === undefined) {
    throw new Error(`missing ${name}`);
  }

  return found[1].trim();
}

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export function configJson(name: string): Schema.Json {
  return decodeJsonText(config(name).replaceAll(/,\s*([}\]])/gu, "$1"));
}

const WranglerConfig = Schema.Struct({
  build: Schema.optional(Schema.Struct({ command: Schema.String })),
  cache: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
  containers: Schema.optional(
    Schema.Array(Schema.Struct({ instance_type: Schema.optional(Schema.String) })),
  ),
});

export type WranglerConfig = typeof WranglerConfig.Type;

const decodeWranglerConfig = Schema.decodeUnknownSync(WranglerConfig);

export function parsedConfig(name: string): WranglerConfig {
  return decodeWranglerConfig(configJson(name));
}
