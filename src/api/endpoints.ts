export type Method = "GET" | "POST";

export type RouteClass = "record-only" | "workspace";

type EndpointSpec = Readonly<{ cost: RouteClass }>;

const ENDPOINTS = {
  "GET /api/status": { cost: "record-only" },
  "GET /api/projects": { cost: "record-only" },
  "POST /api/projects/connect": { cost: "workspace" },
  "POST /api/projects/:projectId/disconnect": { cost: "workspace" },
  "POST /api/projects/:projectId/messages": { cost: "workspace" },
  "GET /api/projects/:projectId/events": { cost: "record-only" },
  "GET /api/projects/:projectId/entries": { cost: "record-only" },
  "POST /api/projects/:projectId/abort": { cost: "record-only" },
  "POST /api/projects/:projectId/thread/fresh": { cost: "record-only" },
  "GET /api/github/connection": { cost: "record-only" },
  "POST /api/github/connection/refresh": { cost: "workspace" },
  "POST /api/github/authorization": { cost: "workspace" },
  "POST /api/github/authorization/complete": { cost: "workspace" },
  "GET /api/chatgpt/connection": { cost: "record-only" },
  "POST /api/chatgpt/login": { cost: "record-only" },
  "POST /api/chatgpt/login/complete": { cost: "record-only" },
  "POST /api/chatgpt/disconnect": { cost: "record-only" },
  "POST /api/generations/submit": { cost: "workspace" },
  "POST /api/generations/activate": { cost: "workspace" },
  "POST /api/generations/rollback": { cost: "workspace" },
  "POST /api/workspace/reset": { cost: "workspace" },
  "GET /api/workspace/backend": { cost: "record-only" },
  "POST /api/workspace/backend": { cost: "record-only" },
} as const satisfies Readonly<Record<`${Method} /api/${string}`, EndpointSpec>>;

export type Endpoint = keyof typeof ENDPOINTS;

export type ProjectEndpoint = Extract<Endpoint, `${string}/:projectId/${string}`>;

type FixedEndpoint = Exclude<Endpoint, ProjectEndpoint>;

export type Location<E extends Endpoint> = E extends ProjectEndpoint
  ? Readonly<{ projectId: string }>
  : Readonly<{ projectId?: never }>;

export type EndpointMatch =
  | Readonly<{ kind: "fixed"; endpoint: FixedEndpoint }>
  | Readonly<{ kind: "project"; endpoint: ProjectEndpoint; projectId: string }>;

const PROJECT_ID = ":projectId";

function isEndpoint(key: string): key is Endpoint {
  return Object.hasOwn(ENDPOINTS, key);
}

function isProjectEndpoint(endpoint: Endpoint): endpoint is ProjectEndpoint {
  return endpoint.includes(`/${PROJECT_ID}/`);
}

type Route = Readonly<{
  endpoint: Endpoint;
  method: Method;
  pattern: string;
  segments: readonly string[];
}>;

function routeOf(endpoint: Endpoint): Route {
  const method: Method = endpoint.startsWith("POST ") ? "POST" : "GET";
  const pattern = endpoint.slice(method.length + 1);

  return { endpoint, method, pattern, segments: pattern.split("/") };
}

export const ENDPOINT_ROUTES: readonly Route[] = Object.keys(ENDPOINTS)
  .filter(isEndpoint)
  .map(routeOf);

function matches(route: Route, segments: readonly string[]): boolean {
  return (
    route.segments.length === segments.length &&
    route.segments.every((expected, index) =>
      expected === PROJECT_ID ? segments[index] !== "" : expected === segments[index],
    )
  );
}

function decodedProjectId(route: Route, segments: readonly string[]): string | undefined {
  try {
    return decodeURIComponent(segments[route.segments.indexOf(PROJECT_ID)] ?? "");
  } catch {
    return undefined;
  }
}

export function matchEndpoint(method: string, pathname: string): EndpointMatch | undefined {
  const segments = pathname.split("/");

  const route = ENDPOINT_ROUTES.find(
    (known) => known.method === method && matches(known, segments),
  );

  if (route === undefined) return undefined;

  const { endpoint } = route;

  if (!isProjectEndpoint(endpoint)) return { kind: "fixed", endpoint };

  const projectId = decodedProjectId(route, segments);

  return projectId === undefined ? undefined : { kind: "project", endpoint, projectId };
}

export function endpointPattern(pathname: string): string | undefined {
  const segments = pathname.split("/");

  return ENDPOINT_ROUTES.find((route) => matches(route, segments))?.pattern;
}

export function routeClass(pattern: string): RouteClass {
  return ENDPOINT_ROUTES.some(
    (route) => route.pattern === pattern && ENDPOINTS[route.endpoint].cost === "workspace",
  )
    ? "workspace"
    : "record-only";
}

export function methodOf(endpoint: Endpoint): Method {
  return routeOf(endpoint).method;
}

export function endpointPath(endpoint: Endpoint, projectId: string | undefined): string {
  const { pattern } = routeOf(endpoint);

  return projectId === undefined
    ? pattern
    : pattern.replace(PROJECT_ID, encodeURIComponent(projectId));
}
