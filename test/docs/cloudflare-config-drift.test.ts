import { expect, test } from "vitest";
import cloudflareConfig from "../../cloudflare.config.js";
import { isRecord } from "../../src/untrusted.js";
import { parsedConfig } from "./wrangler-files.js";

/**
 * `cloudflare.config.ts` is the source of truth for the Worker. Two Wrangler files remain: the
 * Deploy to Cloudflare flow and `wrangler deploy` read `wrangler.jsonc`, and the vitest pool reads
 * `wrangler.test.jsonc` (its `cloudflare.config.ts` support cannot resolve a Durable Object binding
 * to the Worker itself). These tests fail when either Wrangler file drifts from the source of
 * truth, and when a live Durable Object class is missing or not SQLite-backed. Both formats declare
 * Durable Objects with `exports`, so `wrangler deploy` and `cf deploy` state the same lifecycle.
 */

/** The deployment facts that both configuration formats state, in one shape. */
type Facts = Readonly<{
  name: unknown;
  entrypoint: unknown;
  compatibilityDate: unknown;
  compatibilityFlags: unknown;
  workersDev: unknown;
  cacheEnabled: unknown;
  observability: unknown;
  routes: unknown;
  durableObjectBindings: unknown;
  durableObjectExports: unknown;
  container: unknown;
  vars: unknown;
  secrets: unknown;
  workerLoaders: unknown;
  ai: unknown;
}>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- `at` is the one place that narrows the untyped configuration values.
function at(value: unknown, ...path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    value,
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Narrows an untyped configuration value.
function entries(value: unknown): readonly (readonly [string, unknown])[] {
  return isRecord(value) ? Object.entries(value) : [];
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Narrows an untyped configuration value.
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Narrows an untyped configuration value.
function keysOf(value: unknown): readonly string[] {
  return entries(value)
    .map(([key]) => key)
    .toSorted();
}

function sorted<T>(values: readonly T[]): readonly T[] {
  return values.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// Wrangler writes the Dockerfile path as "./containers/..."; the new file may omit the "./".
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reads an untyped configuration value.
function dockerfilePath(value: unknown): string {
  return String(value).replace(/^\.\//u, "");
}

// A Wrangler binding without `script_name`, and a cf binding that names its own Worker, both point
// at the Worker itself. Any other target is a different Worker.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reads untyped configuration values.
function bindingTarget(scriptName: unknown, ownName: unknown): string {
  return scriptName === undefined || scriptName === ownName ? "local" : JSON.stringify(scriptName);
}

// Wrangler spells keys in snake_case and `cloudflare.config.ts` in camelCase.
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Converts an untyped nested configuration value.
function camelKeys(value: unknown): unknown {
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key.replaceAll(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase()),
      camelKeys(inner),
    ]),
  );
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
    observability: camelKeys(at(wrangler, "observability")),
    routes: list(at(wrangler, "routes")).map((route) => ({
      pattern: at(route, "pattern"),
      zone: at(route, "zone_name"),
    })),
    durableObjectBindings: sorted(
      list(at(wrangler, "durable_objects", "bindings")).map((binding) => ({
        binding: at(binding, "name"),
        exportName: at(binding, "class_name"),
        target: bindingTarget(at(binding, "script_name"), at(wrangler, "name")),
      })),
    ),
    durableObjectExports: Object.fromEntries(
      entries(at(wrangler, "exports")).map(([exportName, entry]) => [
        exportName,
        {
          type: at(entry, "type"),
          storage: at(entry, "storage"),
          container: at(entry, "container"),
        },
      ]),
    ),
    container: {
      name: at(container, "name"),
      dockerfile: dockerfilePath(at(container, "image")),
      buildContext: at(container, "image_build_context"),
      maxInstances: at(container, "max_instances"),
      instanceType: at(container, "instance_type"),
    },
    vars: at(wrangler, "vars") ?? {},
    secrets: sorted(list(at(wrangler, "secrets", "required"))),
    workerLoaders: list(at(wrangler, "worker_loaders")).map((loader) => at(loader, "binding")),
    ai: at(wrangler, "ai", "binding"),
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reads an untyped configuration value.
function cloudflareExports(worker: unknown): Facts["durableObjectExports"] {
  return Object.fromEntries(
    entries(at(worker, "exports")).map(([exportName, entry]) => [
      exportName,
      {
        type: at(entry, "type"),
        storage: at(entry, "storage"),
        container: at(entry, "container", "name"),
      },
    ]),
  );
}

function cloudflareFacts(): Facts {
  const worker = at(cloudflareConfig, "worker");
  const env = entries(at(worker, "env"));
  const container = list(at(cloudflareConfig, "containers"))[0];

  return {
    name: at(worker, "name"),
    entrypoint: at(worker, "entrypoint"),
    compatibilityDate: at(worker, "compatibilityDate"),
    compatibilityFlags: sorted(list(at(worker, "compatibilityFlags"))),
    workersDev: at(worker, "workersDev"),
    cacheEnabled: at(worker, "cache", "enabled"),
    observability: at(worker, "observability"),
    routes: list(at(worker, "triggers"))
      .filter((trigger) => at(trigger, "type") === "fetch")
      .map((trigger) => ({ pattern: at(trigger, "pattern"), zone: at(trigger, "zone") })),
    durableObjectBindings: sorted(
      env
        .filter(([, binding]) => at(binding, "type") === "durable-object")
        .map(([binding, value]) => ({
          binding,
          exportName: at(value, "exportName"),
          target: bindingTarget(at(value, "worker"), at(worker, "name")),
        })),
    ),
    durableObjectExports: cloudflareExports(worker),
    container: {
      name: at(container, "name"),
      dockerfile: dockerfilePath(at(container, "image", "dockerfile")),
      buildContext: at(container, "image", "buildContext"),
      maxInstances: at(container, "maxInstances"),
      instanceType: at(container, "instanceType"),
    },
    secrets: sorted(
      env.filter(([, binding]) => at(binding, "type") === "secret").map(([key]) => key),
    ),
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

const WRANGLER_KEYS = [
  "$schema",
  "ai",
  "build",
  "cache",
  "compatibility_date",
  "compatibility_flags",
  "containers",
  "durable_objects",
  "exports",
  "main",
  "name",
  "observability",
  "routes",
  "vars",
  "worker_loaders",
  "workers_dev",
];

const WRANGLER_CONTAINER_KEYS = [
  "image",
  "image_build_context",
  "instance_type",
  "max_instances",
  "name",
];

const CLOUDFLARE_WORKER_KEYS = [
  "cache",
  "compatibilityDate",
  "compatibilityFlags",
  "entrypoint",
  "env",
  "exports",
  "name",
  "observability",
  "triggers",
  "workersDev",
];

const CLOUDFLARE_CONTAINER_KEYS = ["image", "instanceType", "maxInstances", "name"];

test("no configuration field escapes the comparison", () => {
  const withoutAi = WRANGLER_KEYS.filter((key) => key !== "ai");
  const wranglerContainer = list(at(parsedConfig("wrangler.jsonc"), "containers"))[0];

  expect(keysOf(parsedConfig("wrangler.jsonc"))).toEqual(WRANGLER_KEYS);
  expect(keysOf(parsedConfig("wrangler.test.jsonc"))).toEqual(withoutAi);
  expect(keysOf(wranglerContainer)).toEqual(WRANGLER_CONTAINER_KEYS);
  expect(keysOf(list(at(parsedConfig("wrangler.test.jsonc"), "containers"))[0])).toEqual(
    WRANGLER_CONTAINER_KEYS,
  );
  expect(keysOf(at(cloudflareConfig, "worker"))).toEqual(CLOUDFLARE_WORKER_KEYS);
  expect(keysOf(list(at(cloudflareConfig, "containers"))[0])).toEqual(CLOUDFLARE_CONTAINER_KEYS);
  expect(keysOf(cloudflareConfig)).toEqual(["containers", "worker"]);
});

test("traces, logs, and Issues stay enabled with every rate at 1", () => {
  const expected = {
    enabled: true,
    headSamplingRate: 1,
    logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
    traces: { enabled: true, headSamplingRate: 1, persist: true },
    issues: { enabled: true },
  };

  expect(cloudflareFacts().observability).toEqual(expected);
  expect(wranglerFacts("wrangler.jsonc").observability).toEqual(expected);
});

test("no secret is declared and the ChatGPT model is the one plain variable, in every configuration", () => {
  for (const facts of [
    cloudflareFacts(),
    wranglerFacts("wrangler.jsonc"),
    wranglerFacts("wrangler.test.jsonc"),
  ]) {
    expect(facts.secrets).toEqual([]);
    expect(keysOf(facts.vars)).toEqual(["CHATGPT_MODEL"]);
  }
});

test("every cloudflare.config.ts binding is one the comparison maps", () => {
  const types = entries(at(cloudflareConfig, "worker", "env")).map(([, binding]) =>
    at(binding, "type"),
  );

  expect(sorted(types).join(" ")).toBe("ai durable-object durable-object text worker-loader");
});

test("every configuration declares exactly one container", () => {
  expect(list(at(parsedConfig("wrangler.jsonc"), "containers"))).toHaveLength(1);
  expect(list(at(parsedConfig("wrangler.test.jsonc"), "containers"))).toHaveLength(1);
  expect(list(at(cloudflareConfig, "containers"))).toHaveLength(1);
});

test("the container name is the one Wrangler derives from the Worker and the class", () => {
  for (const facts of [wranglerFacts("wrangler.jsonc"), cloudflareFacts()]) {
    const [hostClass] = entries(facts.durableObjectExports).find(
      ([, entry]) => at(entry, "container") !== undefined,
    ) ?? [""];

    expect(at(facts.container, "name")).toBe(`${String(facts.name)}-${hostClass.toLowerCase()}`);
  }
});

test("every live Durable Object class is declared as SQLite-backed with its binding", () => {
  const facts = cloudflareFacts();

  expect(facts.durableObjectExports).toEqual({
    Supervisor: { type: "durable-object", storage: "sqlite", container: undefined },
    WorkspaceHost: {
      type: "durable-object",
      storage: "sqlite",
      container: "cf-stumble-workspacehost",
    },
  });
  expect(facts.durableObjectBindings).toEqual([
    { binding: "SUPERVISOR", exportName: "Supervisor", target: "local" },
    { binding: "WORKSPACE_HOST", exportName: "WorkspaceHost", target: "local" },
  ]);
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
