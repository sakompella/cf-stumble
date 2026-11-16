import * as Schema from "effect/Schema";

export const SentMessage = Schema.Struct({ ok: Schema.Literal(true), submissionId: Schema.Number });
