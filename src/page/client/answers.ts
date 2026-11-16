import * as Schema from "effect/Schema";
import { BackendSetting } from "../../backend-setting.js";
import { GitHubStatus } from "./api.js";

const RefusalProblem = Schema.Struct({ code: Schema.String });

export const GitHubAnswer = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    github: GitHubStatus,
    checkedAt: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ ok: Schema.Literal(false), problem: RefusalProblem }),
]);

export const ConnectAnswer = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    alreadyConnected: Schema.Boolean,
  }),
  Schema.Struct({ ok: Schema.Literal(false), problem: RefusalProblem }),
]);

export const ChatGPTAnswer = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), chatgpt: Schema.Json }),
  Schema.Struct({
    ok: Schema.Literal(false),
    problem: RefusalProblem,
    chatgpt: Schema.optional(Schema.Json),
  }),
]);

export const OkAnswer = Schema.Struct({ ok: Schema.Literal(true) });

export const BackendAnswer = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), backend: BackendSetting }),
  Schema.Struct({ ok: Schema.Literal(false), problem: RefusalProblem }),
]);
