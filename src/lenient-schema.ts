import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

const Dropped = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Undefined, {
    decode: SchemaGetter.omit(),
    encode: SchemaGetter.omit(),
  }),
);

export function lenient<S extends Schema.Constraint>(schema: S) {
  return Schema.optional(Schema.Union([schema, Dropped]));
}
