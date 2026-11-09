import { WorkerEntrypoint } from "cloudflare:workers";
import { logEvent } from "../../diagnostics.js";

export const ISOLATE_EGRESS_ORIGINS: readonly string[] = [
  "https://github.com",
  "https://api.github.com",
  "https://raw.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://registry.npmjs.org",
  "https://pypi.org",
  "https://files.pythonhosted.org",
  "https://developers.cloudflare.com",
];

const ALLOWED_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(ISOLATE_EGRESS_ORIGINS);

const USER_AGENT = "cf-stumble-isolate";

const MAX_REDIRECTS = 5;

type EgressFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function refusal(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function refused(reason: string, host: string | null): Response {
  logEvent("warn", "workspace.isolate-egress.refused", { reason, host: host ?? "unknown" });

  if (reason === "method-not-allowed")
    return refusal(405, "isolate egress: only GET and HEAD requests are allowed");

  if (reason === "host-not-allowed")
    return refusal(
      403,
      `isolate egress: ${host ?? "this host"} is not an allowed host; allowed: ${ISOLATE_EGRESS_ORIGINS.join(", ")}`,
    );

  return refusal(400, "isolate egress: only absolute https URLs are allowed");
}

function originOf(url: string): { origin: string; host: string } | null {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:") return null;

    return { origin: parsed.origin, host: parsed.hostname };
  } catch {
    return null;
  }
}

function resolveFrom(base: string, location: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

export function isolateEgressFetch(upstream: EgressFetch): EgressFetch {
  const forward = (url: string, method: string): Promise<Response> =>
    upstream(url, { method, headers: { "user-agent": USER_AGENT }, redirect: "manual" });

  return async (input, init): Promise<Response> => {
    let url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const target = originOf(url);

    if (!ALLOWED_METHODS.has(method)) return refused("method-not-allowed", null);

    if (target === null || !ALLOWED_ORIGINS.has(target.origin))
      return refused("host-not-allowed", target?.host ?? null);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await forward(url, method);

      if (response.status < 300 || response.status >= 400) return response;

      const location = response.headers.get("location");
      const next = location === null ? null : resolveFrom(url, location);
      const nextOrigin = next === null ? null : originOf(next);

      if (next === null || nextOrigin === null || !ALLOWED_ORIGINS.has(nextOrigin.origin))
        return refused("host-not-allowed", nextOrigin?.host ?? null);

      url = next;
    }

    return refusal(508, "isolate egress: too many redirects");
  };
}

export class IsolateEgressGateway extends WorkerEntrypoint {
  override fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return isolateEgressFetch((request, requestInit) => fetch(request, requestInit))(input, init);
  }
}
