import * as Schema from "effect/Schema";

export const ORB_PING = "ping";

export const ORB_PONG = "pong";

export const ORB_TOKEN_HEADER = "x-stumble-orb-token";

export const ORB_PROVIDER_PATH = "/orb/provider";

export const ORB_COMPUTERD_PATH = "/orb/computerd";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const HeaderList = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));

const Body = Schema.NullOr(Schema.String);

const StartJob = Schema.TaggedStruct("start", {
  container: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
});

const StopJob = Schema.TaggedStruct("stop", { container: Schema.String });

const DeleteJob = Schema.TaggedStruct("delete", { container: Schema.String });

const OrbJob = Schema.Union([StartJob, StopJob, DeleteJob]);

export const orbJob = {
  start: (fields: Omit<typeof StartJob.Type, "_tag">) => StartJob.make(fields),
  stop: (fields: Omit<typeof StopJob.Type, "_tag">) => StopJob.make(fields),
  delete: (fields: Omit<typeof DeleteJob.Type, "_tag">) => DeleteJob.make(fields),
};

export type OrbJob = typeof OrbJob.Type;

const JobFrame = Schema.TaggedStruct("job", { id: Count, job: OrbJob });

const FetchFrame = Schema.TaggedStruct("fetch", {
  id: Count,
  port: Count,
  method: Schema.String,
  path: Schema.String,
  headers: HeaderList,
  body: Body,
});

const HostFrame = Schema.Union([JobFrame, FetchFrame]);

export const hostFrame = {
  job: (fields: Omit<typeof JobFrame.Type, "_tag">) => JobFrame.make(fields),
  fetch: (fields: Omit<typeof FetchFrame.Type, "_tag">) => FetchFrame.make(fields),
};

export type HostFrame = typeof HostFrame.Type;

const Hello = Schema.TaggedStruct("hello", { egressPort: Count });

const JobDone = Schema.TaggedStruct("job-done", {
  id: Count,
  runtime: Schema.NullOr(Schema.String),
});

const FetchResult = Schema.TaggedStruct("fetch-result", {
  id: Count,
  status: Count,
  headers: HeaderList,
  body: Body,
});

const Failed = Schema.TaggedStruct("failed", { id: Count, message: Schema.String });

const Exited = Schema.TaggedStruct("exited", { runtime: Schema.String, reason: Schema.String });

const ProviderFrame = Schema.Union([Hello, JobDone, FetchResult, Failed, Exited]);

export const providerFrame = {
  hello: (fields: Omit<typeof Hello.Type, "_tag">) => Hello.make(fields),
  jobDone: (fields: Omit<typeof JobDone.Type, "_tag">) => JobDone.make(fields),
  fetchResult: (fields: Omit<typeof FetchResult.Type, "_tag">) => FetchResult.make(fields),
  failed: (fields: Omit<typeof Failed.Type, "_tag">) => Failed.make(fields),
  exited: (fields: Omit<typeof Exited.Type, "_tag">) => Exited.make(fields),
};

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
