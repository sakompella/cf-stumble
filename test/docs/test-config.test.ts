// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- This test reads two untyped configuration formats and compares the facts they share; `at` is the one boundary that narrows them.
import { expect, test } from "vitest";
import cloudflareConfig from "../../cloudflare.config.js";
import { isRecord } from "../../src/routes/json.js";

/**
 * `cloudflare.config.ts` is the source of truth for the Worker. Two Wrangler files remain: the
 * Deploy to Cloudflare flow and `wrangler deploy` read `wrangler.jsonc`, and the vitest pool reads
 * `wrangler.test.jsonc` (its `cloudflare.config.ts` support cannot resolve a Durable Object binding
 * to the Worker itself). The tests below fail when either Wrangler file drifts from the source of
 * truth, and when a live Durable Object class is missing or not SQLite-backed.
 *
 * Declaring Workers AI opens a remote connection for every Workers test, so one network failure
 * can fail unrelated tests. Tests therefore load a copy of the Worker configuration without that
 * binding, and this check keeps the copy from drifting in any other way.
 *
 * Vite resolves the glob at build time, so this reads no filesystem and runs in workerd.
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

function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .trim();
}

function config(name: string): string {
  const found = Object.entries(configs).find(([path]) => path.endsWith(name));

  if (found === undefined) {
    throw new Error(`missing ${name}`);
  }

  return withoutComments(found[1]);
}

type WranglerContainer = Readonly<{ instance_type?: unknown }>;

type WranglerConfig = Readonly<{
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

function parsedConfig(name: string): WranglerConfig {
  const json = config(name).replaceAll(/,\s*([}\]])/gu, "$1");
  const parsed: unknown = JSON.parse(json);

  if (!isWranglerConfig(parsed)) {
    throw new Error(`invalid ${name}`);
  }

  return parsed;
}

test("the test Worker configuration differs from production only by name and the AI binding", () => {
  const production = config("wrangler.jsonc");
  const testing = config("wrangler.test.jsonc");

  expect(production).toContain('"ai": { "binding": "AI" }');
  expect(testing).not.toContain('"ai"');
  expect(testing.replace('"cf-stumble-test"', '"cf-stumble"')).toBe(
    production.replace('  "ai": { "binding": "AI" },\n', ""),
  );
});

test("Workers Cache is explicitly disabled in both configurations", () => {
  expect(parsedConfig("wrangler.jsonc").cache?.enabled).toBe(false);
  expect(parsedConfig("wrangler.test.jsonc").cache?.enabled).toBe(false);
});

test("workspace containers use the checked workload size", () => {
  for (const name of ["wrangler.jsonc", "wrangler.test.jsonc"]) {
    expect(parsedConfig(name).containers?.[0]?.instance_type).toBe("standard-3");
  }
});

/** The deployment facts that both configuration formats state, in one shape. */
type Facts = Readonly<{
  name: unknown;
  entrypoint: unknown;
  compatibilityDate: unknown;
  compatibilityFlags: unknown;
  workersDev: unknown;
  cacheEnabled: unknown;
  observabilityEnabled: unknown;
  routes: unknown;
  durableObjectBindings: unknown;
  sqliteDurableObjects: unknown;
  container: unknown;
  vars: unknown;
  workerLoaders: unknown;
  ai: unknown;
}>;

function at(value: unknown, ...path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    value,
  );
}

function entries(value: unknown): readonly (readonly [string, unknown])[] {
  return isRecord(value) ? Object.entries(value) : [];
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function sorted<T>(values: readonly T[]): readonly T[] {
  return values.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function wranglerFacts(name: string): Facts {
  const wrangler: unknown = parsedConfig(name);
  const container = list(at(wrangler, "containers"))[0];

  return {
    name: at(wrangler, "name"),
    entrypoint: at(wrangler, "main"),
    compatibilityDate: at(wrangler, "compatibility_date"),
    compatibilityFlags: sorted(list(at(wrangler, "compatibility_flags"))),
    workersDev: at(wrangler, "workers_dev"),
    cacheEnabled: at(wrangler, "cache", "enabled"),
    observabilityEnabled: at(wrangler, "observability", "enabled"),
    routes: list(at(wrangler, "routes")).map((route) => ({
      pattern: at(route, "pattern"),
      zone: at(route, "zone_name"),
    })),
    durableObjectBindings: sorted(
      list(at(wrangler, "durable_objects", "bindings")).map((binding) => ({
        binding: at(binding, "name"),
        exportName: at(binding, "class_name"),
      })),
    ),
    sqliteDurableObjects: sorted(
      list(at(wrangler, "migrations")).flatMap((migration) =>
        list(at(migration, "new_sqlite_classes")),
      ),
    ),
    container: {
      exportName: at(container, "class_name"),
      dockerfile: dockerfilePath(at(container, "image")),
      buildContext: at(container, "image_build_context"),
      maxInstances: at(container, "max_instances"),
      instanceType: at(container, "instance_type"),
    },
    vars: at(wrangler, "vars"),
    workerLoaders: list(at(wrangler, "worker_loaders")).map((loader) => at(loader, "binding")),
    ai: at(wrangler, "ai", "binding"),
  };
}

function cloudflareFacts(): Facts {
  const worker = at(cloudflareConfig, "worker");
  const env = entries(at(worker, "env"));
  const containers = list(at(cloudflareConfig, "containers"));

  const hostEntry = entries(at(worker, "exports")).find(
    ([, entry]) => at(entry, "container") !== undefined,
  );

  const hostClass = hostEntry?.[0];
  const containerName = at(hostEntry?.[1], "container", "name");

  const container = containers.find((candidate) => at(candidate, "name") === containerName);

  return {
    name: at(worker, "name"),
    entrypoint: at(worker, "entrypoint"),
    compatibilityDate: at(worker, "compatibilityDate"),
    compatibilityFlags: sorted(list(at(worker, "compatibilityFlags"))),
    workersDev: at(worker, "workersDev"),
    cacheEnabled: at(worker, "cache", "enabled"),
    observabilityEnabled: at(worker, "observability", "enabled"),
    routes: list(at(worker, "triggers"))
      .filter((trigger) => at(trigger, "type") === "fetch")
      .map((trigger) => ({ pattern: at(trigger, "pattern"), zone: at(trigger, "zone") })),
    durableObjectBindings: sorted(
      env
        .filter(([, binding]) => at(binding, "type") === "durable-object")
        .map(([binding, value]) => ({ binding, exportName: at(value, "exportName") })),
    ),
    sqliteDurableObjects: sorted(
      entries(at(worker, "exports"))
        .filter(([, entry]) => at(entry, "storage") === "sqlite")
        .map(([exportName]) => exportName),
    ),
    container: {
      exportName: hostClass,
      dockerfile: dockerfilePath(at(container, "image", "dockerfile")),
      buildContext: at(container, "image", "buildContext"),
      maxInstances: at(container, "maxInstances"),
      instanceType: at(container, "instanceType"),
    },
    vars: Object.fromEntries(
      env
        .filter(([, binding]) => at(binding, "type") === "text")
        .map(([key, binding]) => [key, at(binding, "value")]),
    ),
    workerLoaders: env
      .filter(([, binding]) => at(binding, "type") === "worker-loader")
      .map(([key]) => key),
    ai: env.find(([, binding]) => at(binding, "type") === "ai")?.[0],
  };
}

// Wrangler writes the Dockerfile path as "./containers/..."; the new file may omit the "./".
function dockerfilePath(value: unknown): string {
  return String(value).replace(/^\.\//u, "");
}

test("every live Durable Object class is declared as SQLite-backed with its binding", () => {
  const facts = cloudflareFacts();

  expect(facts.sqliteDurableObjects).toEqual(["Supervisor", "WorkspaceHost"]);
  expect(facts.durableObjectBindings).toEqual([
    { binding: "SUPERVISOR", exportName: "Supervisor" },
    { binding: "WORKSPACE_HOST", exportName: "WorkspaceHost" },
  ]);
  expect(
    entries(at(cloudflareConfig, "worker", "exports"))
      .map(([exportName]) => exportName)
      .toSorted(),
  ).toEqual(["Supervisor", "WorkspaceHost"]);
});

test("wrangler.jsonc states the same deployment as cloudflare.config.ts", () => {
  expect(wranglerFacts("wrangler.jsonc")).toEqual(cloudflareFacts());
});

test("wrangler.test.jsonc states the same deployment as cloudflare.config.ts, apart from name and AI", () => {
  expect(wranglerFacts("wrangler.test.jsonc")).toEqual({
    ...cloudflareFacts(),
    name: "cf-stumble-test",
    ai: undefined,
  });
});
