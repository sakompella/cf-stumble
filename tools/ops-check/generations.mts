import * as Schema from "effect/Schema";
import { MODULE_MAPS_BINDING } from "../../infra/worker-settings.ts";
import type { JsonValue } from "../json.mts";
import type { Source, TimeWindow } from "./check.mts";
import { ApiFailure, decoded, readToken, resolveAccount, send } from "./fetch.mts";

const API = "https://api.cloudflare.com/client/v4";

const EVENTS_PREFIX = "history/events/";

const SWITCH_KINDS: readonly string[] = ["activated", "rolled-back"];

export interface EventKey {
  readonly key: string;
  readonly epoch: number;
  readonly kind: string;
  readonly modifiedMs: number;
}

export interface HistoryEvent {
  readonly kind: string;
  readonly actor: string;
  readonly label: number;
  readonly atMs: number;
}

export interface GenerationHistory {
  readonly active: HistoryEvent | null;
  readonly inWindow: readonly HistoryEvent[];
}

const SettingsResponse = Schema.Struct({
  result: Schema.Struct({
    bindings: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        bucket_name: Schema.optional(Schema.String),
      }),
    ),
  }),
});

const ListResponse = Schema.Struct({
  result: Schema.Array(Schema.Struct({ key: Schema.String, last_modified: Schema.String })),
  result_info: Schema.optional(
    Schema.Struct({
      cursor: Schema.optional(Schema.String),
      is_truncated: Schema.optional(Schema.Boolean),
    }),
  ),
});

const EventFile = Schema.Struct({
  kind: Schema.String,
  actor: Schema.optional(Schema.String),
  label: Schema.Number,
  time: Schema.String,
});

export interface EventKeyPage {
  readonly keys: readonly EventKey[];
  readonly cursor: string | null;
}

export function parseEventKeys(response: JsonValue): EventKeyPage {
  const listed = decoded(ListResponse, response, "the R2 object list had an unexpected shape");

  const keys = listed.result.flatMap((object): EventKey[] => {
    const match = /^history\/events\/(\d+)-([a-z-]+)\.json$/u.exec(object.key);

    if (match?.[1] === undefined || match[2] === undefined) return [];

    return [
      {
        key: object.key,
        epoch: Number(match[1]),
        kind: match[2],
        modifiedMs: Date.parse(object.last_modified),
      },
    ];
  });

  const info = listed.result_info;

  return {
    keys,
    cursor: info?.is_truncated === true && info.cursor !== undefined ? info.cursor : null,
  };
}

export function latestSwitch(keys: readonly EventKey[]): EventKey | undefined {
  return keys
    .filter((key) => SWITCH_KINDS.includes(key.kind))
    .toSorted((a, b) => b.epoch - a.epoch)[0];
}

export function parseEvent(response: JsonValue): HistoryEvent {
  const event = decoded(EventFile, response, "an R2 history event had an unexpected shape");

  return {
    kind: event.kind,
    actor: event.actor ?? "unknown",
    label: event.label,
    atMs: Date.parse(event.time),
  };
}

async function moduleMapsBucket(token: string, account: string, worker: string): Promise<string> {
  const settings = decoded(
    SettingsResponse,
    await send(token, `${API}/accounts/${account}/workers/scripts/${worker}/settings`),
    `the settings of ${worker} had an unexpected shape`,
  );

  const binding = settings.result.bindings.find((entry) => entry.name === MODULE_MAPS_BINDING);

  if (binding?.bucket_name === undefined) {
    throw new ApiFailure(`${worker} has no ${MODULE_MAPS_BINDING} bucket binding`);
  }

  return binding.bucket_name;
}

async function listEventKeys(objects: string, token: string): Promise<readonly EventKey[]> {
  const keys: EventKey[] = [];
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams({ prefix: EVENTS_PREFIX, per_page: "1000" });

    if (cursor !== null) query.set("cursor", cursor);

    const page = parseEventKeys(await send(token, `${objects}?${query.toString()}`));
    keys.push(...page.keys);
    cursor = page.cursor;
  } while (cursor !== null);

  return keys;
}

export async function fetchGenerationHistory(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<GenerationHistory> {
  const bucket = await moduleMapsBucket(token, account, worker);
  const objects = `${API}/accounts/${account}/r2/buckets/${bucket}/objects`;
  const keys = await listEventKeys(objects, token);
  const latest = latestSwitch(keys);
  const read = async (key: EventKey) => parseEvent(await send(token, `${objects}/${key.key}`));

  const [active, recent] = await Promise.all([
    latest === undefined ? null : read(latest),
    Promise.all(keys.filter((key) => key.modifiedMs >= window.fromMs).map(read)),
  ]);

  return {
    active,
    inWindow: recent.filter((event) => event.atMs >= window.fromMs),
  };
}

export async function gatherGenerationHistory(
  worker: string,
  window: TimeWindow,
  env: NodeJS.ProcessEnv,
): Promise<Source<GenerationHistory>> {
  try {
    const token = readToken(env);
    const account = await resolveAccount(token, env);

    return { status: "ok", data: await fetchGenerationHistory(token, account, worker, window) };
  } catch (cause) {
    const reason =
      cause instanceof ApiFailure ? cause.message : `unexpected failure: ${String(cause)}`;

    return { status: "unavailable", reason };
  }
}

function byActor(events: readonly HistoryEvent[], always: readonly string[]): string {
  const counts = new Map(always.map((actor) => [actor, 0]));

  for (const event of events) counts.set(event.actor, (counts.get(event.actor) ?? 0) + 1);

  return [...counts].map(([actor, count]) => `${actor} ${count}`).join(", ");
}

export function generationLine(history: Source<GenerationHistory>): readonly string[] {
  if (history.status !== "ok") return [`i generations unknown: ${history.reason}`];

  const { active, inWindow } = history.data;
  const ofKind = (kind: string) => inWindow.filter((event) => event.kind === kind);
  const rolledBack = ofKind("rolled-back");

  const serving =
    active === null
      ? "no activation in the history"
      : `generation ${active.label} active (${active.kind} by ${active.actor})`;

  const rollbacks = rolledBack.length === 0 ? "" : ` (${byActor(rolledBack, [])})`;

  return [
    `i generations: ${serving}; in the window activated ${byActor(ofKind("activated"), ["owner", "conversation"])}; proven ${ofKind("proven").length}; rolled back ${rolledBack.length}${rollbacks}`,
  ];
}
