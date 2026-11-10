import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Predicate from "effect/Predicate";
import { expect, test } from "vitest";
import { isModelStreamEvent } from "../../../src/facet/generation-1/route-events.js";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

type Spec =
  | { readonly kind: "str" | "num" | "bool" | "null" }
  | { readonly kind: "lit"; readonly value: string | boolean }
  | { readonly kind: "arr"; readonly item: Spec }
  | { readonly kind: "union"; readonly options: readonly Spec[] }
  | {
      readonly kind: "obj";
      readonly required: Readonly<Record<string, Spec>>;
      readonly optional: Readonly<Record<string, Spec>>;
    };

const str: Spec = { kind: "str" };

const num: Spec = { kind: "num" };

const bool: Spec = { kind: "bool" };

const nul: Spec = { kind: "null" };

const lit = (value: string | boolean): Spec => ({ kind: "lit", value });

const union = (...options: Spec[]): Spec => ({ kind: "union", options });

const arr = (item: Spec): Spec => ({ kind: "arr", item });

const obj = (required: Record<string, Spec>, optional: Record<string, Spec> = {}): Spec => ({
  kind: "obj",
  required,
  optional,
});

const EVENT: Spec = union(
  obj({ type: lit("text-delta"), delta: str }),
  obj({
    type: lit("tool-call-delta"),
    delta: obj({ index: num }, { id: str, name: str, argumentsDelta: str }),
  }),
  obj(
    {
      type: lit("done"),
      message: obj({
        role: lit("assistant"),
        content: union(str, nul),
        tool_calls: arr(obj({ id: str, function: obj({ name: str, arguments: str }) })),
      }),
      usage: obj({ inputTokens: num, outputTokens: num, estimated: bool }),
    },
    { truncated: lit(true) },
  ),
  obj({
    type: lit("error"),
    error: obj(
      { code: union(lit("model-unavailable"), lit("chatgpt-reconnect-required")) },
      { detail: str },
    ),
  }),
  obj({
    type: lit("provider-fallback"),
    reason: lit("chatgpt-usage-limit"),
    limitedUntil: union(num, nul),
  }),
);

type Site = {
  readonly spec: Spec;
  readonly value: Json;
  readonly rebuild: (inner: Json | undefined) => Json;
};

function isRecord(value: Json | undefined): value is { readonly [key: string]: Json } {
  return Predicate.isObject(value) && !Array.isArray(value);
}

function isList(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

function conforms(spec: Spec, value: Json | undefined): boolean {
  switch (spec.kind) {
    case "str":
      return Predicate.isString(value);
    case "num":
      return Predicate.isNumber(value);
    case "bool":
      return Predicate.isBoolean(value);
    case "null":
      return value === null;
    case "lit":
      return value === spec.value;
    case "arr":
      return isList(value) && value.every((item) => conforms(spec.item, item));
    case "union":
      return spec.options.some((option) => conforms(option, value));
    case "obj":
      break;
  }

  return (
    isRecord(value) &&
    Object.entries(spec.required).every(([key, inner]) => conforms(inner, value[key])) &&
    Object.entries(spec.optional).every(
      ([key, inner]) => !(key in value) || conforms(inner, value[key]),
    )
  );
}

const jsonScalar = gs.oneOf<Json>(
  gs.text({ maxSize: 6 }),
  gs.integers({ minValue: -1000, maxValue: 1000 }),
  gs.floats({ allowNan: false, allowInfinity: false }),
  gs.booleans(),
  gs.just(null),
);

function drawValue(tc: hegel.TestCase, spec: Spec): Json {
  switch (spec.kind) {
    case "str":
      return tc.draw(gs.text({ maxSize: 8 }));
    case "num":
      return tc.draw(
        gs.oneOf<number>(
          gs.integers({ minValue: -1000, maxValue: 1000 }),
          gs.floats({ allowNan: false, allowInfinity: false }),
        ),
      );
    case "bool":
      return tc.draw(gs.booleans());
    case "null":
      return null;
    case "lit":
      return spec.value;
    case "arr":
      return Array.from({ length: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) }, () =>
        drawValue(tc, spec.item),
      );
    case "union":
      return drawValue(tc, tc.draw(gs.sampledFrom(spec.options)));
    case "obj":
      break;
  }

  return drawObject(tc, spec);
}

function drawObject(tc: hegel.TestCase, spec: Extract<Spec, { kind: "obj" }>): Json {
  const fields: Record<string, Json> = {};

  for (const [key, inner] of Object.entries(spec.required)) fields[key] = drawValue(tc, inner);

  for (const [key, inner] of Object.entries(spec.optional)) {
    if (tc.draw(gs.booleans())) fields[key] = drawValue(tc, inner);
  }

  if (tc.draw(gs.booleans())) fields["x-extra"] = tc.draw(jsonScalar);

  return fields;
}

function without(record: { readonly [key: string]: Json }, key: string): Json {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function sitesOf(spec: Spec, value: Json, rebuild: Site["rebuild"]): readonly Site[] {
  const here: Site = { spec, value, rebuild };

  if (spec.kind === "union") {
    const match = spec.options.find((option) => conforms(option, value));

    return [here, ...(match === undefined ? [] : sitesOf(match, value, rebuild))];
  }

  if (spec.kind === "arr" && isList(value)) {
    return [
      here,
      ...value.flatMap((item, index) =>
        sitesOf(spec.item, item, (inner) =>
          rebuild(value.map((old, at) => (at === index ? (inner ?? null) : old))),
        ),
      ),
    ];
  }

  if (spec.kind === "obj" && isRecord(value)) {
    return [
      here,
      ...Object.entries(value).flatMap(([key, item]) => {
        const child = spec.required[key] ?? spec.optional[key];

        return child === undefined
          ? []
          : sitesOf(child, item, (inner) =>
              rebuild(inner === undefined ? without(value, key) : { ...value, [key]: inner }),
            );
      }),
    ];
  }

  return [here];
}

const wrongs = (old: Json): readonly Json[] => [
  null,
  true,
  false,
  0,
  -1.5,
  "",
  "unknown-tag",
  [],
  {},
  [old],
  { value: old },
];

function drawEvent(tc: hegel.TestCase): Json {
  return drawValue(tc, EVENT);
}

test("accepts every generated well-formed event, with or without optional and extra fields", () => {
  hegel.test((tc) => {
    const event = drawEvent(tc);

    expect(conforms(EVENT, event)).toBe(true);
    expect(isModelStreamEvent(event), JSON.stringify(event)).toBe(true);
  });
});

test("refuses a well-formed event after one field is deleted, retyped, mistagged or nested deeper", () => {
  hegel.test((tc) => {
    const event = drawEvent(tc);
    const sites = sitesOf(EVENT, event, (inner) => inner ?? null);
    const site = tc.draw(gs.sampledFrom(sites));
    const replacement = tc.draw(gs.sampledFrom(wrongs(site.value)));

    tc.assume(!conforms(site.spec, replacement));

    const damaged = site.rebuild(replacement);

    tc.assume(!conforms(EVENT, damaged));
    expect(isModelStreamEvent(damaged), JSON.stringify(damaged)).toBe(false);
  });
});

test("refuses a well-formed event once a required field is deleted", () => {
  hegel.test((tc) => {
    const event = drawEvent(tc);

    const holders = sitesOf(EVENT, event, (inner) => inner ?? null).flatMap((site) =>
      site.spec.kind === "obj" && isRecord(site.value)
        ? [
            {
              required: Object.keys(site.spec.required),
              record: site.value,
              rebuild: site.rebuild,
            },
          ]
        : [],
    );

    const holder = tc.draw(gs.sampledFrom(holders));
    const key = tc.draw(gs.sampledFrom(holder.required));
    const damaged = holder.rebuild(without(holder.record, key));

    expect(isModelStreamEvent(damaged), JSON.stringify(damaged)).toBe(false);
  });
});
