import type { Random } from "./random.mts";

export type Method = "GET" | "POST";

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

const FIXED: readonly Route[] = [
  { method: "GET", path: "/", body: "none" },
  { method: "GET", path: "/health", body: "none" },
  { method: "GET", path: "/favicon.svg", body: "none" },
  { method: "GET", path: "/api/status", body: "none" },
  { method: "GET", path: "/api/projects", body: "none" },
  { method: "GET", path: "/api/github/connection", body: "none" },
  { method: "GET", path: "/api/chatgpt/connection", body: "none" },
  { method: "GET", path: "/api/workspace/backend", body: "none" },
  { method: "GET", path: "/orb/provider", body: "none" },
  { method: "GET", path: "/orb/computerd", body: "none" },
  { method: "POST", path: "/api/projects/connect", body: "connect", spends: "connect" },
  { method: "POST", path: "/api/github/connection/refresh", body: "none", spends: "github" },
  { method: "POST", path: "/api/github/authorization", body: "none", spends: "github" },
  { method: "POST", path: "/api/github/authorization/complete", body: "none", spends: "github" },
  { method: "POST", path: "/api/chatgpt/login", body: "none", spends: "chatgpt" },
  { method: "POST", path: "/api/chatgpt/login/complete", body: "complete" },
  { method: "POST", path: "/api/chatgpt/disconnect", body: "none" },
  { method: "POST", path: "/api/generations/submit", body: "submit", spends: "submit" },
  { method: "POST", path: "/api/generations/activate", body: "control" },
  { method: "POST", path: "/api/generations/rollback", body: "control" },
  { method: "POST", path: "/api/workspace/reset", body: "none", spends: "reset" },
  { method: "POST", path: "/api/workspace/backend", body: "backend" },
];

const PROJECT_ROUTES: readonly Route[] = [
  { method: "POST", path: "/messages", body: "message" },
  { method: "GET", path: "/events", body: "none" },
  { method: "GET", path: "/entries", body: "none" },
  { method: "POST", path: "/abort", body: "none" },
  { method: "POST", path: "/thread/fresh", body: "none" },
  { method: "POST", path: "/disconnect", body: "none" },
];

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

const FIXED_KEYS = new Set(FIXED.map((route) => `${route.method} ${route.path}`));

const PROJECT_KEYS = new Set(PROJECT_ROUTES.map((route) => `${route.method} ${route.path}`));

export function isKnownRoute(method: string, raw: string, scriptPath: string): boolean {
  const path = normalizedPath(raw);

  if (FIXED_KEYS.has(`${effectiveMethod(method)} ${path}`)) return true;

  if (effectiveMethod(method) === "GET" && path === scriptPath) return true;

  const project = /^\/api\/projects\/([^/]+)(\/.+)$/u.exec(path);

  if (project?.[1] === undefined || project[2] === undefined) return false;

  try {
    decodeURIComponent(project[1]);
  } catch {
    return false;
  }

  return PROJECT_KEYS.has(`${effectiveMethod(method)} ${project[2]}`);
}
