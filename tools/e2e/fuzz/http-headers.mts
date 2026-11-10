import type { Credential, Header } from "./http-case.mts";
import type { Random } from "./random.mts";

const VALID_AUTHORIZATIONS = [
  "Basic {valid}",
  "basic {valid}",
  "BASIC   {valid}",
  "Basic {unpadded}",
];

const INVALID_AUTHORIZATIONS = [
  "Basic",
  "Basic ",
  "Basic {valid}x",
  "Basic x{valid}",
  "Basic {valid} extra",
  "Basic {valid}, Basic {valid}",
  "Bearer {valid}",
  "Token {valid}",
  'Digest username="aditya"',
  "Negotiate {valid}",
  "{valid}",
  "Basic {wrong}",
  "Basic {other-user}",
  "Basic {no-user}",
  "Basic {user-only}",
  "Basic {newline}",
  "Basic {doubled}",
  "Basic =",
  "Basic ====",
  "Basic !!!!",
  "Basic \u00E9",
  "Basic YWRpdHlh",
  `Basic ${"A".repeat(8_000)}`,
  "Basic {valid}\t{valid}",
  "Basic\t{valid}",
];

const EXTRA_NAMES = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-http-method-override",
  "x-original-url",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-worker",
  "forwarded",
  "via",
  "cookie",
  "referer",
  "accept",
  "accept-encoding",
  "accept-language",
  "range",
  "if-none-match",
  "if-match",
  "if-modified-since",
  "cache-control",
  "pragma",
  "te",
  "user-agent",
  "x-stumble-orb-token",
  "proxy-authorization",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-websocket-key",
  "sec-websocket-version",
  "content-encoding",
  "content-language",
  "content-md5",
  "x-request-id",
  "x-a",
];

const VALUES = [
  "",
  "*",
  "null",
  "0",
  "-1",
  "GET",
  "DELETE",
  "/api/status",
  "gzip",
  "br",
  "deflate, gzip",
  "bytes=0-",
  "bytes=999999999999-",
  'W/"x"',
  "127.0.0.1",
  "::1",
  "evil.example",
  "\u00E9\u00FF",
  "a".repeat(4_000),
  "a=b; c=d",
  "websocket",
  "<script>",
];

export const CONTENT_TYPES = [
  "application/json",
  "application/json; charset=utf-8",
  "application/json; charset=latin1",
  "APPLICATION/JSON",
  "application/vnd.api+json",
  "text/plain",
  "text/plain;charset=UTF-8",
  "application/x-www-form-urlencoded",
  "multipart/form-data; boundary=x",
  "application/octet-stream",
  "text/html",
  ";;;",
  "application/json; charset=",
  "application/json, text/plain",
  "x".repeat(2_000),
  "",
];

export const FOREIGN_ORIGINS = [
  "https://evil.example",
  "http://evil.example",
  "null",
  "",
  "https://evil.example:8443",
  "https://localhost:8787",
  "file://",
  "*",
];

const FETCH_SITES = ["cross-site", "same-site", "none", "same-origin", "", "other", "SAME-ORIGIN"];

export function authorization(random: Random): readonly [Header | undefined, Credential] {
  const roll = random.int(100);

  if (roll < 40) return [undefined, "invalid"];

  if (roll < 90) return [["authorization", random.pick(INVALID_AUTHORIZATIONS)], "invalid"];

  return [["authorization", random.pick(VALID_AUTHORIZATIONS)], "valid"];
}

export function validAuthorization(random: Random): Header {
  return ["authorization", random.pick(VALID_AUTHORIZATIONS)];
}

export function duplicatedAuthorization(random: Random): readonly [readonly Header[], Credential] {
  const first = random.chance(0.5);
  const valid = validAuthorization(random);
  const other = ["authorization", random.pick(INVALID_AUTHORIZATIONS)] as const;

  return [first ? [valid, other] : [other, valid], "either"];
}

export function extraHeaders(random: Random): readonly Header[] {
  const count = random.weighted([
    [5, 0],
    [4, 1],
    [3, 2],
    [2, 5],
    [1, 20],
  ]);

  return Array.from(
    { length: count },
    () => [random.pick(EXTRA_NAMES), random.pick(VALUES)] as const,
  );
}

export function originHeaders(random: Random): readonly Header[] {
  return [
    ...(random.chance(0.8) ? [["origin", random.pick(FOREIGN_ORIGINS)] as const] : []),
    ...(random.chance(0.5) ? [["sec-fetch-site", random.pick(FETCH_SITES)] as const] : []),
    ...(random.chance(0.15) ? [["origin", random.pick(FOREIGN_ORIGINS)] as const] : []),
  ];
}

export const METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "get",
  "post",
  "PROPFIND",
  "PURGE",
  "BREW",
  "X".repeat(200),
];
