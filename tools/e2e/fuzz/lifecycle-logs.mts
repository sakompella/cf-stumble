import * as Schema from "effect/Schema";
import { send } from "../../ops-check/fetch.mts";

const ROW_LIMIT = 2000;

const Rows = Schema.Struct({
  result: Schema.Struct({ events: Schema.Struct({ events: Schema.Array(Schema.Json) }) }),
});

const Event = Schema.Struct({
  timestamp: Schema.Number,
  source: Schema.Struct({
    event: Schema.String,
    outcome: Schema.optional(Schema.String),
    errorCode: Schema.optional(Schema.NullOr(Schema.String)),
    refused: Schema.optional(Schema.NullOr(Schema.String)),
    label: Schema.optional(Schema.Number),
    fallback: Schema.optional(Schema.Number),
  }),
});

export type LoggedEvent = typeof Event.Type;

export type Window = Readonly<{ fromMs: number; toMs: number }>;

export type Account = Readonly<{ token: string; id: string }>;

async function query(account: Account, worker: string, window: Window, needle: string) {
  const body = await send(
    account.token,
    `https://api.cloudflare.com/client/v4/accounts/${account.id}/workers/observability/telemetry/query`,
    {
      queryId: "adhoc",
      view: "events",
      dry: true,
      limit: ROW_LIMIT,
      timeframe: { from: window.fromMs, to: window.toMs },
      parameters: {
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }],
        needle: { value: needle, matchCase: true, isRegex: false },
      },
    },
  );

  return Schema.decodeUnknownSync(Rows)(body).result.events.events;
}

export async function loggedEvents(
  account: Account,
  worker: string,
  window: Window,
  name: string,
): Promise<readonly LoggedEvent[]> {
  const rows = await query(account, worker, window, name);

  return rows.flatMap((row) => {
    const parsed = Schema.decodeUnknownResult(Event)(row);

    return parsed._tag === "Success" && parsed.success.source.event === name
      ? [parsed.success]
      : [];
  });
}

export async function mentions(
  account: Account,
  worker: string,
  window: Window,
  needle: string,
): Promise<number> {
  return (await query(account, worker, window, needle)).length;
}
