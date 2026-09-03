// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- These are
// the type guards the facet's parse boundaries share. A decoded JSON value, a saved document, and
// a model-supplied tool argument all arrive without a proven shape, so the guards accept `unknown`
// and the object guard reports the only representation an unvalidated JSON object has.

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
