import type { Workspace } from "@cloudflare/computer";
import { WorkerEntrypoint } from "cloudflare:workers";
import { readGitHubToken } from "./github-remote.js";

const GITHUB_API_ORIGIN = "https://api.github.com";

const MAX_REDIRECTS = 5;

const REQUEST_BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
] as const;

type EgressFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function refusal(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function resolveFrom(base: string, location: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

function redirectsAsGet(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD";

  return (status === 301 || status === 302) && method === "POST";
}

export function isolateEgressFetch(upstream: EgressFetch, githubToken?: string): EgressFetch {
  return async (input, init): Promise<Response> => {
    const request = new Request(input, init);
    const carried = new Headers(request.headers);
    let { method, url } = request;
    let body = request.body === null ? null : await request.arrayBuffer();

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const headers = new Headers(carried);

      if (
        originOf(url) === GITHUB_API_ORIGIN &&
        githubToken !== undefined &&
        !carried.has("authorization")
      )
        headers.set("authorization", `Bearer ${githubToken}`);

      const response = await upstream(url, { method, headers, body, redirect: "manual" });

      if (response.status < 300 || response.status >= 400) return response;

      const location = response.headers.get("location");
      const next = location === null ? null : resolveFrom(url, location);

      if (next === null) return response;

      if (originOf(next) !== originOf(url)) {
        carried.delete("authorization");
        carried.delete("cookie");
      }

      if (redirectsAsGet(response.status, method)) {
        method = "GET";
        body = null;

        for (const name of REQUEST_BODY_HEADERS) carried.delete(name);
      }

      url = next;
    }

    return refusal(508, "isolate egress: too many redirects");
  };
}

interface GateHost {
  openIsolateWorkspace(token: string): Promise<ReturnType<Workspace["stub"]>>;
}

export interface IsolateEgressGatewayProps {
  readonly id: string;
  readonly token: string;
}

interface EgressEnv {
  readonly WORKSPACE_HOST: Readonly<{ idFromString(id: string): DurableObjectId }> & {
    get(id: DurableObjectId): GateHost;
  };
  readonly GH_TOKEN?: string;
}

export class IsolateEgressGateway extends WorkerEntrypoint<EgressEnv, IsolateEgressGatewayProps> {
  override async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { id, token } = this.ctx.props;

    const workspace = await this.env.WORKSPACE_HOST.get(
      this.env.WORKSPACE_HOST.idFromString(id),
    ).openIsolateWorkspace(token);

    const githubToken = await readGitHubToken(workspace.fs, this.env.GH_TOKEN);

    return isolateEgressFetch((request, requestInit) => fetch(request, requestInit), githubToken)(
      input,
      init,
    );
  }
}
