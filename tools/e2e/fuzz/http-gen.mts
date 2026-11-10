import * as Schema from "effect/Schema";
import { generateBody } from "./http-bodies.mts";
import type { Case, Credential, Header } from "./http-case.mts";
import {
  CONTENT_TYPES,
  METHODS,
  authorization,
  duplicatedAuthorization,
  extraHeaders,
  originHeaders,
  validAuthorization,
} from "./http-headers.mts";
import { mutatePath, randomQuery } from "./http-paths.mts";
import { normalizedPath, pickRoute, unknownProject, type Targets } from "./http-routes.mts";
import type { Random } from "./random.mts";

export type Generator = Readonly<{ next: () => Case }>;

type Family = "unauthenticated" | "authenticated" | "cross-origin" | "orb" | "duplicate-credential";

const SPEND_LIMITS: ReadonlyMap<string, number> = new Map([
  ["connect", 6],
  ["submit", 4],
  ["reset", 2],
  ["github", 6],
  ["chatgpt", 4],
]);

const SPENDING_PATHS: ReadonlyMap<string, string> = new Map([
  ["/api/projects/connect", "connect"],
  ["/api/generations/submit", "submit"],
  ["/api/workspace/reset", "reset"],
  ["/api/github/connection/refresh", "github"],
  ["/api/github/authorization", "github"],
  ["/api/github/authorization/complete", "github"],
  ["/api/chatgpt/login", "chatgpt"],
]);

const WRITE_METHODS = ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "post", "BREW"];

const ConnectBody = Schema.Struct({
  repositoryUrl: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/[^/?#@]+\/[^/?#@]+$/iu),
  ),
  displayName: Schema.optionalKey(Schema.String),
});

const SubmitBody = Schema.Struct({
  harnessCommit: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)),
});

const MessageBody = Schema.Struct({
  content: Schema.String.check(Schema.isMinLength(1)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

const decodeConnect = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectBody), {
  onExcessProperty: "error",
});

const decodeSubmit = Schema.decodeUnknownOption(Schema.fromJsonString(SubmitBody), {
  onExcessProperty: "error",
});

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(MessageBody), {
  onExcessProperty: "error",
});

function bodyText(probe: Case): string {
  return probe.body?.kind === "text" ? probe.body.text : "";
}

function actionable(spend: string, probe: Case): boolean {
  const text = bodyText(probe);

  if (spend === "connect") return decodeConnect(text)._tag === "Some";

  if (spend === "submit") return decodeSubmit(text)._tag === "Some";

  return true;
}

function messageIsLive(probe: Case): boolean {
  const decoded = decodeMessage(bodyText(probe));

  return (
    decoded._tag === "Some" &&
    decoded.value.content.trim() !== "" &&
    Buffer.byteLength(decoded.value.content) <= 100_000
  );
}

function decodeOrSelf(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export class Guard {
  readonly #remaining = new Map(SPEND_LIMITS);
  readonly #targets: Targets;

  constructor(targets: Targets) {
    this.#targets = targets;
  }

  apply(probe: Case): Case {
    if (probe.credential === "invalid" || probe.method.toUpperCase() !== "POST") return probe;

    const path = normalizedPath(probe.path);
    const spend = SPENDING_PATHS.get(path);

    if (spend !== undefined && actionable(spend, probe)) {
      const left = this.#remaining.get(spend) ?? 0;

      this.#remaining.set(spend, left - 1);

      return left > 0 ? probe : { ...probe, method: "GET" };
    }

    return this.#guardProject(probe, path);
  }

  #guardProject(probe: Case, path: string): Case {
    const real = this.#targets.realProject;
    const project = /^\/api\/projects\/([^/]+)(\/.+)$/u.exec(path);

    if (real === undefined || project?.[1] === undefined) return probe;

    if (decodeOrSelf(project[1]) !== real) return probe;

    const unsafe =
      project[2] === "/disconnect" || (project[2] === "/messages" && messageIsLive(probe));

    return unsafe ? { ...probe, path: probe.path.replace(project[1], unknownProject()) } : probe;
  }
}

function contentType(random: Random): readonly Header[] {
  return random.chance(0.2) ? [] : [["content-type", random.pick(CONTENT_TYPES)]];
}

const ORB_TOKENS = ["", "x", "0".repeat(36), "a".repeat(4_000), "null", "undefined"];

function orbHeaders(random: Random): readonly Header[] {
  return [
    ...(random.chance(0.8) ? [["x-stumble-orb-token", random.pick(ORB_TOKENS)] as const] : []),
    ...(random.chance(0.7)
      ? [["upgrade", "websocket"] as const, ["connection", "Upgrade"] as const]
      : []),
    ...(random.chance(0.4)
      ? [
          ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="] as const,
          ["sec-websocket-version", "13"] as const,
        ]
      : []),
  ];
}

function pairOf(
  pair: readonly [Header | undefined, Credential],
): readonly [readonly Header[], Credential] {
  return [pair[0] === undefined ? [] : [pair[0]], pair[1]];
}

function credentials(random: Random, family: Family): readonly [readonly Header[], Credential] {
  if (family === "unauthenticated" || family === "orb") return pairOf(authorization(random));

  if (family === "duplicate-credential") return duplicatedAuthorization(random);

  return [[validAuthorization(random)], "valid"];
}

function crossOriginHeaders(random: Random, family: Family, ownOrigin: string): readonly Header[] {
  if (family !== "cross-origin") return random.chance(0.05) ? originHeaders(random) : [];

  if (random.chance(0.25)) {
    return random.chance(0.5) ? [["origin", ownOrigin]] : [["sec-fetch-site", "same-origin"]];
  }

  return originHeaders(random);
}

function methodFor(random: Random, family: Family, routed: string): string {
  if (family === "cross-origin") return random.pick(WRITE_METHODS);

  return random.chance(0.7) ? routed : random.pick(METHODS);
}

function pathFor(random: Random, family: Family, basePath: string): string {
  const base = family === "orb" ? random.pick(["/orb/provider", "/orb/computerd"]) : basePath;

  if (random.chance(0.45)) return mutatePath(random, base);

  return random.chance(0.15) ? `${base}${randomQuery(random)}` : base;
}

export function createGenerator(
  random: Random,
  targets: Targets,
  ownOrigin: string,
  guard: Guard,
  hugeLeft: { count: number },
): Generator {
  function build(family: Family): Case {
    const route = pickRoute(random, targets);

    const method = methodFor(random, family, route.method);
    const bodied = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const wantsHuge = hugeLeft.count > 0 && random.chance(0.02);

    const { spec } =
      bodied || random.chance(0.1)
        ? generateBody(random, route.body, wantsHuge)
        : { spec: undefined };

    if (wantsHuge && spec?.kind === "repeat" && spec.count > 10_000_000) hugeLeft.count -= 1;

    const [authHeaders, credential] = credentials(random, family);

    return {
      method,
      path: pathFor(random, family, route.path),
      headers: [
        ...authHeaders,
        ...crossOriginHeaders(random, family, ownOrigin),
        ...(family === "orb" ? orbHeaders(random) : []),
        ...extraHeaders(random),
        ...(spec === undefined ? [] : contentType(random)),
      ],
      body: spec,
      credential,
    };
  }

  return {
    next: () =>
      guard.apply(
        build(
          random.weighted<Family>([
            [22, "unauthenticated"],
            [48, "authenticated"],
            [18, "cross-origin"],
            [6, "orb"],
            [6, "duplicate-credential"],
          ]),
        ),
      ),
  };
}
