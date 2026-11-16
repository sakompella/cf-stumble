import {
  ENDPOINT_ROUTES,
  matchEndpoint,
  type Endpoint,
  type Method,
} from "../../../src/api/endpoints.ts";
import type { Random } from "./random.mts";

export type RouteBody =
  | "none"
  | "connect"
  | "submit"
  | "control"
  | "complete"
  | "backend"
  | "message";

export type Route = Readonly<{
  method: Method;
  path: string;
  body: RouteBody;
  spends?: string;
}>;

export type Targets = Readonly<{
  realProject: string | undefined;
  scriptPath: string;
}>;

const UNKNOWN_PROJECT = "fz-unknown";

const FUZZ: Readonly<Record<Endpoint, Readonly<{ body: RouteBody; spends?: string }>>> = {
  "GET /api/status": { body: "none" },
  "GET /api/projects": { body: "none" },
  "POST /api/projects/connect": { body: "connect", spends: "connect" },
  "POST /api/projects/:projectId/disconnect": { body: "none" },
  "POST /api/projects/:projectId/messages": { body: "message" },
  "GET /api/projects/:projectId/events": { body: "none" },
  "GET /api/projects/:projectId/entries": { body: "none" },
  "POST /api/projects/:projectId/abort": { body: "none" },
  "POST /api/projects/:projectId/thread/fresh": { body: "none" },
  "GET /api/github/connection": { body: "none" },
  "POST /api/github/connection/refresh": { body: "none", spends: "github" },
  "POST /api/github/authorization": { body: "none", spends: "github" },
  "POST /api/github/authorization/complete": { body: "none", spends: "github" },
  "GET /api/chatgpt/connection": { body: "none" },
  "POST /api/chatgpt/login": { body: "none", spends: "chatgpt" },
  "POST /api/chatgpt/login/complete": { body: "complete" },
  "POST /api/chatgpt/disconnect": { body: "none" },
  "POST /api/generations/submit": { body: "submit", spends: "submit" },
  "POST /api/generations/activate": { body: "control" },
  "POST /api/generations/rollback": { body: "control" },
  "POST /api/workspace/reset": { body: "none", spends: "reset" },
  "GET /api/workspace/backend": { body: "none" },
  "POST /api/workspace/backend": { body: "backend" },
};

const API_ROUTES: readonly Route[] = ENDPOINT_ROUTES.map(({ endpoint, method, pattern }) => ({
  method,
  path: pattern,
  ...FUZZ[endpoint],
}));

const PROJECT_PREFIX = "/api/projects/:projectId";

const FIXED: readonly Route[] = [
  { method: "GET", path: "/", body: "none" },
  { method: "GET", path: "/health", body: "none" },
  { method: "GET", path: "/favicon.svg", body: "none" },
  { method: "GET", path: "/orb/provider", body: "none" },
  { method: "GET", path: "/orb/computerd", body: "none" },
  ...API_ROUTES.filter((route) => !route.path.startsWith(PROJECT_PREFIX)),
];

const PROJECT_ROUTES: readonly Route[] = API_ROUTES.flatMap((route) =>
  route.path.startsWith(PROJECT_PREFIX)
    ? [{ ...route, path: route.path.slice(PROJECT_PREFIX.length) }]
    : [],
);

export const SPENDING_PATHS: ReadonlyMap<string, string> = new Map(
  API_ROUTES.flatMap((route) => (route.spends === undefined ? [] : [[route.path, route.spends]])),
);

const PROJECT_IDS = [
  "fz-unknown",
  "a",
  "x--1d",
  "connect",
  "events",
  "UPPER",
  "-",
  "a--",
  "%20",
  "..",
  "%2e%2e",
  "a%2fb",
  "%E2%82%AC",
  "%ff",
  "%00",
  "a".repeat(200),
  "a".repeat(201),
  "a".repeat(5000),
  "1".repeat(300),
];

export function projectId(random: Random, targets: Targets): string {
  return targets.realProject !== undefined && random.chance(0.4)
    ? targets.realProject
    : random.pick(PROJECT_IDS);
}

export function pickRoute(random: Random, targets: Targets): Route {
  if (random.chance(0.45)) {
    const route = random.pick(PROJECT_ROUTES);

    return { ...route, path: `/api/projects/${projectId(random, targets)}${route.path}` };
  }

  if (random.chance(0.05)) return { method: "GET", path: targets.scriptPath, body: "none" };

  return random.pick(FIXED);
}

export function unknownProject(): string {
  return UNKNOWN_PROJECT;
}

const EXEMPT = new Set(["/health", "/orb/provider", "/orb/computerd"]);

export function normalizedPath(raw: string): string {
  return URL.parse(`https://worker.invalid${raw}`)?.pathname ?? raw;
}

export function isExempt(method: string, raw: string): boolean {
  return effectiveMethod(method) === "GET" && EXEMPT.has(normalizedPath(raw));
}

const CASE_FOLDED = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

export function effectiveMethod(method: string): string {
  const upper = method.toUpperCase();

  return CASE_FOLDED.has(upper) ? upper : method;
}

export function hasDotSegment(raw: string): boolean {
  return /(?:^|\/)(?:\.|%2e){1,2}(?:[/?]|$)/iu.test(raw);
}

export function isOrb(raw: string): boolean {
  return normalizedPath(raw).startsWith("/orb/");
}

export function isKnownRoute(method: string, raw: string, scriptPath: string): boolean {
  const path = normalizedPath(raw);

  if (FIXED.some((route) => route.method === effectiveMethod(method) && route.path === path)) {
    return true;
  }

  if (effectiveMethod(method) === "GET" && path === scriptPath) return true;

  return matchEndpoint(effectiveMethod(method), path) !== undefined;
}
