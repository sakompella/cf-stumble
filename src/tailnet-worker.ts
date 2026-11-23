import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Tailnet } from "../build/tailnet/index.js";

interface TailnetEnv {
  readonly NODE: DurableObjectNamespace<TailnetObject>;
  readonly TS_AUTHKEY?: string;
  readonly TS_HOSTNAME: string;
  readonly TAILNET_ALLOWED_HOSTS?: string;
}

function allowed(request: Request, env: TailnetEnv): boolean {
  const url = new URL(request.url);

  const hosts = (env.TAILNET_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    hosts.includes(url.hostname.toLowerCase())
  );
}

export class TailnetObject extends DurableObject<TailnetEnv> {
  #node: ReturnType<typeof Tailnet.start> | undefined;

  #start() {
    this.#node ??= Tailnet.start(this.ctx, {
      authKey: this.env.TS_AUTHKEY,
      hostname: this.env.TS_HOSTNAME,
      ephemeral: true,
      onLog: () => {},
    });

    return this.#node;
  }

  override async fetch(request: Request): Promise<Response> {
    if (!allowed(request, this.env))
      return new Response("tailnet host is not allowlisted", { status: 403 });

    const node = await this.#start();

    await node.ready();

    return node.fetch(request);
  }

  override async alarm(): Promise<void> {
    await (await this.#start()).alarm();
  }

  async status() {
    const node = await this.#start();

    return { node: node.status() };
  }

  async logout(): Promise<void> {
    await (await this.#start()).logout();

    await this.ctx.storage.deleteAlarm();
  }
}

export class TailnetAdmin extends WorkerEntrypoint<TailnetEnv> {
  status() {
    return this.env.NODE.getByName("main").status();
  }

  logout() {
    return this.env.NODE.getByName("main").logout();
  }
}

export default class extends WorkerEntrypoint<TailnetEnv> {
  override fetch(request: Request): Promise<Response> {
    if (!allowed(request, this.env))
      return Promise.resolve(new Response("tailnet host is not allowlisted", { status: 403 }));

    return this.env.NODE.getByName("main").fetch(request);
  }
}
