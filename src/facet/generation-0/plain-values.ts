// oxlint-disable anti-slop/no-unsafe-dictionary-type -- These are
// the type guards the facet's parse boundaries share. A turn request that crossed an RPC hop and a
// model-supplied tool argument both arrive without a proven shape, so the guards accept `unknown`
// and the object guard reports the only representation an unvalidated JSON object has.

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
