import * as Schema from "effect/Schema";

const SentMessage = Schema.Struct({ ok: Schema.Literal(true), submissionId: Schema.Number });

export const sentMessage = Schema.decodeUnknownOption(SentMessage);
