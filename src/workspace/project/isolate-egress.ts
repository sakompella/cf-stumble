import type { Workspace } from "@cloudflare/computer";
import { WorkerEntrypoint } from "cloudflare:workers";
import { GITHUB_CLI_CONFIG_DIRECTORY } from "../../workspace-layout.js";
import { githubTokenFromHosts } from "./github-remote.js";

const GITHUB_API_ORIGIN = "https://api.github.com";

const MAX_REDIRECTS = 5;

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

export function isolateEgressFetch(upstream: EgressFetch, githubToken?: string): EgressFetch {
  return async (input, init): Promise<Response> => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    const sourceHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    const body = init?.body ?? (input instanceof Request ? input.body : undefined);

    let url = input instanceof Request ? input.url : input.toString();

    const forwardInit = (headers: Headers): RequestInit => {
      const requestInit: RequestInit = { method, headers, redirect: "manual" };

      if (body !== undefined) requestInit.body = body;

      return requestInit;
    };

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const headers = new Headers(sourceHeaders);

      if (
        originOf(url) === GITHUB_API_ORIGIN &&
        githubToken !== undefined &&
        !sourceHeaders.has("authorization")
      )
        headers.set("authorization", `Bearer ${githubToken}`);

      const response = await upstream(url, forwardInit(headers));

      if (response.status < 300 || response.status >= 400) return response;

      const location = response.headers.get("location");
      const next = location === null ? null : resolveFrom(url, location);

      if (next === null) return response;

      url = next;
    }

    return refusal(508, "isolate egress: too many redirects");
  };
}

interface GitHubHostsFile {
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export async function githubTokenForIsolateEgress(
  fs: GitHubHostsFile,
  fallbackToken?: string,
): Promise<string | undefined> {
  let hosts = "";

  try {
    hosts = await fs.readFile(`${GITHUB_CLI_CONFIG_DIRECTORY}/hosts.yml`, "utf8");
  } catch {
    hosts = "";
  }

  return githubTokenFromHosts(hosts) ?? fallbackToken;
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

    const githubToken = await githubTokenForIsolateEgress(workspace.fs, this.env.GH_TOKEN);

    return isolateEgressFetch((request, requestInit) => fetch(request, requestInit), githubToken)(
      input,
      init,
    );
  }
}
