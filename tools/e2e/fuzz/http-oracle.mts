import {
  approximateSize,
  credentialTokens,
  type Case,
  type Header,
  type Reply,
} from "./http-case.mts";
import * as Schema from "effect/Schema";
import {
  EDGE_STATUSES,
  INTENDED_SERVER_CODES,
  INTERNAL_PATTERNS,
  KNOWN_CODES,
  LEAK_PATTERNS,
} from "./http-codes.mts";
import {
  effectiveMethod,
  hasDotSegment,
  isExempt,
  isKnownRoute,
  normalizedPath,
} from "./http-routes.mts";
import { lenientEntriesQuery } from "./http-query.mts";

export type Violation = Readonly<{ oracle: string; detail: string }>;

export type Environment = Readonly<{
  ownOrigin: string;
  scriptPath: string;
  password: string;
  secrets: readonly string[];
}>;

function header(reply: Reply, name: string): string | undefined {
  return reply.headers.find(([key]) => key === name)?.[1];
}

function values(headers: readonly Header[], name: string): string[] {
  return headers.flatMap(([key, value]) => (key.toLowerCase() === name ? [value] : []));
}

const Problem = Schema.Struct({
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String })),
  problem: Schema.optionalKey(Schema.Struct({ code: Schema.String })),
});

const decodeProblem = Schema.decodeUnknownOption(Schema.fromJsonString(Problem));

const decodeAnyJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function isJson(text: string): boolean {
  return decodeAnyJson(text)._tag === "Some";
}

function codeOf(text: string): string | undefined {
  const decoded = decodeProblem(text);

  if (decoded._tag === "None") return undefined;

  return decoded.value.error?.code ?? decoded.value.problem?.code;
}

function isWorkerReply(reply: Reply): boolean {
  return header(reply, "cache-control") === "no-store";
}

function isEdgeRefusal(probe: Case, reply: Reply): boolean {
  const abortedUpload = reply.status === 502 && approximateSize(probe.body) > 100_000;

  return (
    (EDGE_STATUSES.has(reply.status) || abortedUpload) &&
    !isWorkerReply(reply) &&
    !isJson(reply.body)
  );
}

function leaks(probe: Case, reply: Reply, environment: Environment): Violation[] {
  const text = `${reply.body}\n${reply.headers.map(([name, value]) => `${name}: ${value}`).join("\n")}`;

  const presented = Object.entries(credentialTokens(environment.password)).flatMap(([key, token]) =>
    token.length >= 12 && probe.headers.some(([, value]) => value.includes(key)) ? [token] : [],
  );

  const found = [...environment.secrets, ...presented].filter((secret) => text.includes(secret));

  const patterns = LEAK_PATTERNS.filter((pattern) => pattern.test(text));

  return [
    ...(found.length > 0
      ? [
          {
            oracle: "credential-echoed",
            detail: `the answer contains ${found.length} secret value(s)`,
          },
        ]
      : []),
    ...patterns.map((pattern) => ({ oracle: "secret-wellFormed-text", detail: String(pattern) })),
    ...(reply.headers.some(([name]) => name.startsWith("access-control-"))
      ? [{ oracle: "cors-header", detail: "an access-control header was sent" }]
      : []),
    ...(reply.status >= 400 && INTERNAL_PATTERNS.some((pattern) => pattern.test(reply.body))
      ? [{ oracle: "internals-leaked", detail: reply.body.slice(0, 200) }]
      : []),
  ];
}

function crossOrigin(probe: Case, environment: Environment): "yes" | "no" | "either" {
  const origins = values(probe.headers, "origin").filter((origin) => origin !== "");
  const sites = values(probe.headers, "sec-fetch-site");

  if (origins.length > 1 || sites.length > 1) return "either";

  const foreignOrigin = origins[0] !== undefined && origins[0] !== environment.ownOrigin;
  const foreignSite = sites[0] !== undefined && sites[0] !== "same-origin";

  return foreignOrigin || foreignSite ? "yes" : "no";
}

function unauthenticated(probe: Case, reply: Reply, exempt: boolean): Violation[] {
  if (isEdgeRefusal(probe, reply)) return [];

  if (exempt) {
    const path = normalizedPath(probe.path);

    if (path === "/health") {
      return reply.status === 200 && isJson(reply.body)
        ? []
        : [{ oracle: "health-exemption", detail: `status ${reply.status}` }];
    }

    return reply.status === 401
      ? []
      : [
          {
            oracle: "orb-unauthenticated",
            detail: `status ${reply.status}: ${reply.body.slice(0, 120)}`,
          },
        ];
  }

  if (reply.status !== 401) {
    return [
      {
        oracle: "unauthenticated-reached-handler",
        detail: `status ${reply.status}: ${reply.body.slice(0, 160)}`,
      },
    ];
  }

  const wellFormed =
    header(reply, "www-authenticate")?.startsWith("Basic") === true &&
    (effectiveMethod(probe.method) === "HEAD" || reply.body === "Unauthorized\n");

  return wellFormed ? [] : [{ oracle: "unauthorized-shape", detail: reply.body.slice(0, 120) }];
}

function authenticated(probe: Case, reply: Reply, environment: Environment): Violation[] {
  if (isEdgeRefusal(probe, reply)) return [];

  const path = normalizedPath(probe.path);

  if (isExempt(probe.method, probe.path) && path !== "/health") {
    return reply.status === 401
      ? []
      : [{ oracle: "orb-token", detail: `status ${reply.status}: ${reply.body.slice(0, 120)}` }];
  }

  if (path.startsWith("/orb/") && reply.status === 401) return [];

  if (reply.status === 401 && probe.credential === "valid") {
    return [{ oracle: "valid-credential-refused", detail: reply.body.slice(0, 120) }];
  }

  const cross = crossOrigin(probe, environment);
  const mutating = !["GET", "HEAD"].includes(effectiveMethod(probe.method));
  const code = effectiveMethod(probe.method) === "HEAD" ? undefined : codeOf(reply.body);
  const refused = reply.status === 403 && code === "cross-origin-request";

  if (mutating && cross === "yes" && !refused) {
    return [
      {
        oracle: "cross-origin-write-accepted",
        detail: `status ${reply.status}: ${reply.body.slice(0, 160)}`,
      },
    ];
  }

  if (!(mutating && cross !== "no") && refused) {
    return [{ oracle: "same-origin-refused", detail: `status ${reply.status}` }];
  }

  if (refused) return [];

  return classify(probe, reply, code, environment);
}

function classify(
  probe: Case,
  reply: Reply,
  code: string | undefined,
  environment: Environment,
): Violation[] {
  const known =
    hasDotSegment(probe.path) || isKnownRoute(probe.method, probe.path, environment.scriptPath);

  const head = effectiveMethod(probe.method) === "HEAD";
  const path = normalizedPath(probe.path);

  if (head) {
    return reply.status === 404 ? [] : [{ oracle: "head-status", detail: String(reply.status) }];
  }

  if (!known && !(reply.status === 404 && code === "not-found")) {
    return [
      {
        oracle: "unknown-route-not-404",
        detail: `${probe.method} ${path} answered ${reply.status}: ${reply.body.slice(0, 120)}`,
      },
    ];
  }

  const lenient = lenientEntriesQuery(probe, reply);

  if (lenient !== undefined) return [lenient];

  if (reply.status >= 500) {
    return code !== undefined && INTENDED_SERVER_CODES.has(code)
      ? []
      : [{ oracle: "server-error", detail: `status ${reply.status}: ${reply.body.slice(0, 160)}` }];
  }

  if (reply.status >= 400) {
    if (code === undefined)
      return [
        { oracle: "error-not-json", detail: `status ${reply.status}: ${reply.body.slice(0, 160)}` },
      ];

    return KNOWN_CODES.has(code)
      ? []
      : [{ oracle: "unknown-problem-code", detail: `${code} (status ${reply.status})` }];
  }

  const type = header(reply, "content-type") ?? "";

  if (path.startsWith("/api/") && !type.includes("json")) {
    return [{ oracle: "api-content-type", detail: `${reply.status} ${type}` }];
  }

  return [];
}

const PATIENT_ROUTES = /^\/api\/(?:generations|workspace|github|chatgpt|projects\/connect)/u;

function slowLimitMs(raw: string): number {
  return PATIENT_ROUTES.test(normalizedPath(raw)) ? 120_000 : 20_000;
}

export function check(probe: Case, reply: Reply, environment: Environment): Violation[] {
  if (reply.status === 0) {
    return approximateSize(probe.body) > 100_000
      ? []
      : [{ oracle: "transport-error", detail: reply.error ?? "no answer" }];
  }

  const slow =
    reply.ms > slowLimitMs(probe.path) ? [{ oracle: "slow-answer", detail: `${reply.ms} ms` }] : [];

  const exempt = isExempt(probe.method, probe.path);

  const verdict =
    probe.credential === "invalid"
      ? unauthenticated(probe, reply, exempt)
      : probe.credential === "valid"
        ? authenticated(probe, reply, environment)
        : reply.status === 401
          ? unauthenticated(probe, reply, exempt)
          : authenticated(probe, reply, environment);

  return [...verdict, ...leaks(probe, reply, environment), ...slow];
}
