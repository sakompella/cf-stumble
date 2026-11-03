import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { decodeBody, encodeBody } from "./orb-protocol.js";
import type { ProviderLink } from "./provider-link.js";
import type { ProviderExit } from "./provider-state.js";

type ContainerStatus = Awaited<ReturnType<IWorkspaceContainerAPI["status"]>>;

type PortFetcher = ReturnType<IWorkspaceContainerAPI["port"]>;

const SECRET_BYTES = 16;

function clientSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ProviderContainerAPI implements IWorkspaceContainerAPI {
  readonly #link: ProviderLink;
  readonly #container: string;

  constructor(link: ProviderLink, container: string) {
    this.#link = link;
    this.#container = container;
  }

  async start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const secret = clientSecret();
    const env = { ...spec.env, RPC_CLIENT_SECRET: secret };
    const runtime = await this.#link.job({ _tag: "start", container: this.#container, env });

    if (runtime === null) throw new Error("the workspace provider started no container");

    this.#link.update({ _tag: "started", runtime });

    return { runtimeId: runtime, clientSecret: secret, outcome: "launched" };
  }

  restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.start(spec);
  }

  async stop(): Promise<void> {
    await this.#link.job({ _tag: "stop", container: this.#container });
    this.#link.update({ _tag: "stopped" });
  }

  async remove(): Promise<void> {
    await this.#link.job({ _tag: "delete", container: this.#container });
    this.#link.update({ _tag: "stopped" });
  }

  running(): boolean {
    return this.#link.state()._tag === "running";
  }

  status(): Promise<ContainerStatus> {
    const state = this.#link.state();

    return Promise.resolve(
      state._tag === "running"
        ? { running: true, exit: null }
        : { running: false, exit: state.exit },
    );
  }

  exitInfo(): Promise<ProviderExit | null> {
    const state = this.#link.state();

    return Promise.resolve(state._tag === "stopped" ? state.exit : null);
  }

  interceptOutboundHttp(): Promise<void> {
    return Promise.resolve();
  }

  interceptAllOutboundHttp(): Promise<void> {
    return Promise.reject(new Error("a workspace provider has no HTTP gateway"));
  }

  setInactivityTimeout(): Promise<void> {
    return Promise.resolve();
  }

  async fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = encodeBody(new Uint8Array(await request.arrayBuffer()));

    const result = await this.#link.fetch(
      {
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: [...request.headers],
        body,
      },
      init?.signal,
    );

    return new Response(result.body === null ? null : decodeBody(result.body), {
      status: result.status,
      headers: result.headers,
    });
  }

  port(port: number): PortFetcher {
    return {
      fetch: (input, init) => this.fetchPort(port, input, init),
      connect: () => {
        throw new Error("a workspace provider forwards HTTP only");
      },
    };
  }
}
