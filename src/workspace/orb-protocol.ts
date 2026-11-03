import * as Schema from "effect/Schema";

export const ORB_PING = "ping";

export const ORB_PONG = "pong";

export const ORB_TOKEN_HEADER = "x-stumble-orb-token";

export const ORB_PROVIDER_PATH = "/orb/provider";

export const ORB_COMPUTERD_PATH = "/orb/computerd";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const HeaderList = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));

const Body = Schema.NullOr(Schema.String);

const OrbJob = Schema.Union([
  Schema.TaggedStruct("start", {
    container: Schema.String,
    env: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.TaggedStruct("stop", { container: Schema.String }),
  Schema.TaggedStruct("delete", { container: Schema.String }),
]);

export type OrbJob = typeof OrbJob.Type;

const HostFrame = Schema.Union([
  Schema.TaggedStruct("job", { id: Count, job: OrbJob }),
  Schema.TaggedStruct("fetch", {
    id: Count,
    port: Count,
    method: Schema.String,
    path: Schema.String,
    headers: HeaderList,
    body: Body,
  }),
]);

export type HostFrame = typeof HostFrame.Type;

const ProviderFrame = Schema.Union([
  Schema.TaggedStruct("hello", { egressPort: Count }),
  Schema.TaggedStruct("job-done", { id: Count, runtime: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("fetch-result", {
    id: Count,
    status: Count,
    headers: HeaderList,
    body: Body,
  }),
  Schema.TaggedStruct("failed", { id: Count, message: Schema.String }),
  Schema.TaggedStruct("exited", { runtime: Schema.String, reason: Schema.String }),
]);

export type ProviderFrame = typeof ProviderFrame.Type;

export type ProviderReply = Extract<ProviderFrame, { id: number }>;

type WithoutId<Frame> = Frame extends unknown ? Omit<Frame, "id"> : never;

export type HostRequest = WithoutId<HostFrame>;

export const decodeHostFrame = Schema.decodeUnknownOption(Schema.fromJsonString(HostFrame));

export const decodeProviderFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ProviderFrame));

export function encodeFrame(frame: HostFrame | ProviderFrame): string {
  return JSON.stringify(frame);
}

export function encodeBody(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;

  let binary = "";

  for (const byte of bytes) binary += String.fromCodePoint(byte);

  return btoa(binary);
}

export function decodeBody(body: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(body), (char) => char.codePointAt(0) ?? 0);
}
