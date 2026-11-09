import type { Server } from "node:net";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  decodeBody,
  decodeHostFrame,
  encodeBody,
  encodeFrame,
  ORB_PING,
  ORB_PROVIDER_PATH,
  ORB_TOKEN_HEADER,
  providerFrame,
  type HostFrame,
  type OrbJob,
  type ProviderFrame,
} from "../../orb-protocol.js";
import { attempt, dispatch, lastLine, OrbFailure, type DispatchJob } from "./dispatch.js";
import { serveEgress, type WorkerTarget } from "./tunnel.js";

const PING_INTERVAL_MS = 30_000;

type Launch = Readonly<{ runtime: string; container: string; address: string }>;

type FetchAnswer = Readonly<{
  status: number;
  headers: [string, string][];
  body: string | null;
}>;

type Send = (frame: ProviderFrame) => void;

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
  readonly #jobs = Semaphore.makeUnsafe(1);

  constructor(options: ProviderOptions) {
    this.#options = options;
  }

  run(listenHost: string): Effect.Effect<string, OrbFailure> {
    return Effect.acquireUseRelease(
      Effect.sync(() => serveEgress(this.#options)),
      (egress) =>
        attempt(() => listening(egress, listenHost)).pipe(
          Effect.tap((port) =>
            Effect.sync(() => {
              this.#egressPort = port;
              this.#options.log(`computer.internal listener on ${listenHost}:${port}`);
            }),
          ),
          Effect.andThen(this.#connected()),
        ),
      (egress) =>
        Effect.sync(() => {
          egress.close();
        }).pipe(Effect.andThen(this.#jobs.withPermits(1)(this.#stopLaunch("stop"))), Effect.orDie),
    );
  }

  #connected(): Effect.Effect<string> {
    return Effect.scoped(
      Effect.flatMap(FiberSet.makeRuntime(), (runFork) =>
        Effect.callback<string>((resume) => {
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

          const finish = (reason: string): void => {
            clearInterval(ping);
            resume(Effect.succeed(reason));
          };

          socket.addEventListener("open", () => {
            this.#options.log("connected to the Workspace Host");
            send(providerFrame.hello({ egressPort: this.#egressPort }));
          });
          socket.addEventListener("message", (event) => {
            const frame = decodeHostFrame(event.data);

            if (Option.isSome(frame)) runFork(this.#handle(frame.value, send));
          });
          socket.addEventListener("close", (event) => {
            finish(`the Workspace Host connection closed (${event.code} ${event.reason})`);
          });

          return Effect.sync(() => {
            clearInterval(ping);
            socket.close(1000, "provider stopping");
          });
        }),
      ),
    );
  }

  #handle(frame: HostFrame, send: Send): Effect.Effect<void> {
    return this.#answer(frame, send).pipe(
      Effect.catchTag("OrbFailure", ({ message }) =>
        Effect.succeed(providerFrame.failed({ id: frame.id, message })),
      ),
      Effect.map(send),
    );
  }

  #answer(frame: HostFrame, send: Send): Effect.Effect<ProviderFrame, OrbFailure> {
    if (Predicate.isTagged(frame, "fetch"))
      return Effect.map(this.#fetch(frame), (result) =>
        providerFrame.fetchResult({ id: frame.id, ...result }),
      );

    return Effect.map(this.#jobs.withPermits(1)(this.#job(frame.job, send)), (runtime) =>
      providerFrame.jobDone({ id: frame.id, runtime }),
    );
  }

  #script(
    job: DispatchJob,
    container: string,
    env: Record<string, string> = {},
  ): Effect.Effect<string, OrbFailure> {
    return dispatch(this.#options.script, {
      job,
      container,
      egressPort: this.#egressPort,
      env,
    }).pipe(
      Effect.filterOrFail(
        (result) => result.exitCode === 0,
        (result) =>
          new OrbFailure({
            message: `dispatch ${job} exited ${result.exitCode}: ${result.stderr.trim()}`,
          }),
      ),
      Effect.map((result) => result.stdout),
    );
  }

  #job(job: OrbJob, send: Send): Effect.Effect<string | null, OrbFailure> {
    return Effect.suspend(() => {
      this.#options.log(`job ${job._tag} ${job.container}`);

      if (!Predicate.isTagged(job, "start")) {
        this.#launch = undefined;

        return this.#script(job._tag, job.container).pipe(Effect.as(null));
      }

      return this.#stopLaunch("delete").pipe(
        Effect.andThen(
          this.#script("start", job.container, job.env).pipe(
            Effect.flatMap((output) => {
              const address = lastLine(output);

              return address === undefined
                ? Effect.fail(new OrbFailure({ message: "dispatch start printed no address" }))
                : Effect.succeed(address);
            }),
            Effect.onError(() => Effect.ignore(this.#script("delete", job.container))),
          ),
        ),
        Effect.flatMap((address) => {
          const launch = { runtime: crypto.randomUUID(), container: job.container, address };
          this.#launch = launch;

          return Effect.forkDetach(this.#watch(launch, send)).pipe(Effect.as(launch.runtime));
        }),
      );
    });
  }

  #watch(launch: Launch, send: Send): Effect.Effect<void> {
    return this.#script("wait", launch.container).pipe(
      Effect.match({
        onSuccess: (output) => `exited ${lastLine(output) ?? ""}`.trim(),
        onFailure: ({ message }) => message,
      }),
      Effect.flatMap((reason) =>
        Effect.sync(() => {
          if (this.#launch?.runtime !== launch.runtime) return;

          this.#launch = undefined;
          this.#options.log(`container ${launch.container} ${reason}`);
          send(providerFrame.exited({ runtime: launch.runtime, reason }));
        }),
      ),
    );
  }

  #stopLaunch(job: "stop" | "delete"): Effect.Effect<void, OrbFailure> {
    return Effect.suspend(() => {
      const launch = this.#launch;
      this.#launch = undefined;

      return launch === undefined
        ? Effect.void
        : Effect.asVoid(this.#script(job, launch.container));
    });
  }

  #fetch(frame: Extract<HostFrame, { _tag: "fetch" }>): Effect.Effect<FetchAnswer, OrbFailure> {
    return Effect.suspend(() => {
      const launch = this.#launch;

      if (launch === undefined)
        return Effect.fail(new OrbFailure({ message: "no container is running" }));

      return attempt(async () => {
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
      });
    });
  }
}
