import { randomUUID } from "node:crypto";
import type { Server } from "node:net";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  decodeBody,
  decodeHostFrame,
  encodeBody,
  encodeFrame,
  ORB_PING,
  ORB_PROVIDER_PATH,
  ORB_TOKEN_HEADER,
  type HostFrame,
  type OrbJob,
  type ProviderFrame,
} from "../../orb-protocol.js";
import { dispatch, lastLine, type DispatchJob } from "./dispatch.js";
import { serveEgress, type WorkerTarget } from "./tunnel.js";

const PING_INTERVAL_MS = 30_000;

type Launch = Readonly<{ runtime: string; container: string; address: string }>;

export type ProviderOptions = WorkerTarget & Readonly<{ script: string; log(line: string): void }>;

function providerUrl(base: URL): URL {
  const url = new URL(ORB_PROVIDER_PATH, base);
  url.protocol = base.protocol === "https:" ? "wss:" : "ws:";

  return url;
}

const decodeListening = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }));

function listening(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      resolve(Option.getOrThrow(decodeListening(server.address())).port);
    });
  });
}

export class OrbProvider {
  readonly #options: ProviderOptions;
  #egressPort = 0;
  #launch: Launch | undefined;
  #jobs: Promise<unknown> = Promise.resolve();

  constructor(options: ProviderOptions) {
    this.#options = options;
  }

  async run(listenHost: string, signal: AbortSignal): Promise<string> {
    const egress = serveEgress(this.#options);
    this.#egressPort = await listening(egress, listenHost);
    this.#options.log(`computer.internal listener on ${listenHost}:${this.#egressPort}`);

    try {
      return await this.#connected(signal);
    } finally {
      egress.close();
      await this.#queue(() => this.#stopLaunch("stop"));
    }
  }

  #connected(signal: AbortSignal): Promise<string> {
    const socket = new WebSocket(providerUrl(this.#options.url), {
      headers: { [ORB_TOKEN_HEADER]: this.#options.token },
    });

    const send = (frame: ProviderFrame | typeof ORB_PING): void => {
      if (socket.readyState !== WebSocket.OPEN) return;

      socket.send(frame === ORB_PING ? frame : encodeFrame(frame));
    };

    const ping = setInterval(() => {
      send(ORB_PING);
    }, PING_INTERVAL_MS);

    return new Promise<string>((resolve) => {
      const finish = (reason: string): void => {
        clearInterval(ping);
        resolve(reason);
      };

      const stop = (): void => {
        socket.close(1000, "provider stopping");
        finish("the provider is stopping");
      };

      signal.addEventListener("abort", stop, { once: true });
      socket.addEventListener("open", () => {
        this.#options.log("connected to the Workspace Host");
        send({ _tag: "hello", egressPort: this.#egressPort });
      });
      socket.addEventListener("message", (event) => {
        const frame = decodeHostFrame(event.data);

        if (Option.isSome(frame)) void this.#handle(frame.value, send);
      });
      socket.addEventListener("close", (event) => {
        signal.removeEventListener("abort", stop);
        finish(`the Workspace Host connection closed (${event.code} ${event.reason})`);
      });
    });
  }

  async #handle(frame: HostFrame, send: (frame: ProviderFrame) => void): Promise<void> {
    try {
      if (frame._tag === "job") {
        const runtime = await this.#queue(() => this.#job(frame.job, send));
        send({ _tag: "job-done", id: frame.id, runtime });

        return;
      }

      send({ _tag: "fetch-result", id: frame.id, ...(await this.#fetch(frame)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ _tag: "failed", id: frame.id, message });
    }
  }

  #queue<A>(work: () => Promise<A>): Promise<A> {
    const next = this.#jobs.then(work);
    this.#jobs = next.then(
      () => null,
      () => null,
    );

    return next;
  }

  async #script(job: DispatchJob, container: string, env: Record<string, string> = {}) {
    const result = await dispatch(this.#options.script, {
      job,
      container,
      egressPort: this.#egressPort,
      env,
    });

    if (result.exitCode !== 0)
      throw new Error(`dispatch ${job} exited ${result.exitCode}: ${result.stderr.trim()}`);

    return result.stdout;
  }

  async #job(job: OrbJob, send: (frame: ProviderFrame) => void): Promise<string | null> {
    this.#options.log(`job ${job._tag} ${job.container}`);

    if (job._tag !== "start") {
      this.#launch = undefined;
      await this.#script(job._tag, job.container);

      return null;
    }

    await this.#stopLaunch("delete");

    const address = lastLine(await this.#script("start", job.container, job.env));

    if (address === undefined) throw new Error("dispatch start printed no address");

    const launch = { runtime: randomUUID(), container: job.container, address };
    this.#launch = launch;
    void this.#watch(launch, send);

    return launch.runtime;
  }

  async #watch(launch: Launch, send: (frame: ProviderFrame) => void): Promise<void> {
    const reason = await this.#script("wait", launch.container).then(
      (output) => `exited ${lastLine(output) ?? ""}`.trim(),
      String,
    );

    if (this.#launch?.runtime !== launch.runtime) return;

    this.#launch = undefined;
    this.#options.log(`container ${launch.container} ${reason}`);
    send({ _tag: "exited", runtime: launch.runtime, reason });
  }

  async #stopLaunch(job: "stop" | "delete"): Promise<void> {
    const launch = this.#launch;
    this.#launch = undefined;

    if (launch !== undefined) await this.#script(job, launch.container);
  }

  async #fetch(frame: Extract<HostFrame, { _tag: "fetch" }>) {
    const launch = this.#launch;

    if (launch === undefined) throw new Error("no container is running");

    const response = await fetch(`http://${launch.address}${frame.path}`, {
      method: frame.method,
      headers: frame.headers.map(([name, value]) => [name, value]),
      body: frame.body === null ? null : decodeBody(frame.body),
    });

    return {
      status: response.status,
      headers: [...response.headers],
      body: encodeBody(new Uint8Array(await response.arrayBuffer())),
    };
  }
}
