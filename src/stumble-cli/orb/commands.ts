import { resolve } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { printed, refused, type CommandNode, type CommandOutput } from "../tree.js";
import type { OrbFailure } from "./dispatch.js";
import { OrbProvider } from "./provider.js";

export type OrbPorts = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  platform: string;
  arch: string;
  log(line: string): void;
}>;

const DEFAULT_LISTEN_HOST = "127.0.0.1";

const FIRST_RETRY_MS = 1_000;

const LAST_RETRY_MS = 30_000;

const STEADY_CONNECTION_MS = 60_000;

function workerUrl(text: string | undefined): URL | undefined {
  const url = text === undefined ? undefined : URL.parse(text);

  return url?.protocol === "https:" || url?.protocol === "http:" ? url : undefined;
}

function provide(script: string, ports: OrbPorts): Effect.Effect<CommandOutput, OrbFailure> {
  if (ports.platform !== "linux" || ports.arch !== "x64")
    ports.log(
      `warning: the orb provider is tested on x86_64 Linux only, not ${ports.platform} ${ports.arch}`,
    );

  const url = workerUrl(ports.env["STUMBLE_ORB_URL"]);
  const token = ports.env["STUMBLE_ORB_TOKEN"];

  if (url === undefined)
    return Effect.succeed(refused("set STUMBLE_ORB_URL to the Worker's http(s) URL"));

  if (token === undefined || token === "")
    return Effect.succeed(
      refused("set STUMBLE_ORB_TOKEN to the Worker's ORB_PROVIDER_TOKEN secret"),
    );

  const provider = new OrbProvider({ url, token, script: resolve(script), log: ports.log });
  const listenHost = ports.env["STUMBLE_ORB_LISTEN_HOST"] ?? DEFAULT_LISTEN_HOST;

  return Effect.gen(function* () {
    let retryMs = FIRST_RETRY_MS;

    for (;;) {
      const connectedAt = Date.now();
      const ended = yield* provider.run(listenHost);

      if (Date.now() - connectedAt > STEADY_CONNECTION_MS) retryMs = FIRST_RETRY_MS;

      ports.log(`${ended}; connecting again in ${retryMs / 1_000}s`);
      yield* Effect.sleep(retryMs);
      retryMs = Math.min(retryMs * 2, LAST_RETRY_MS);
    }
  });
}

function finished(exit: Exit.Exit<CommandOutput, OrbFailure>): CommandOutput {
  if (Exit.isSuccess(exit)) return exit.value;

  return Cause.hasInterruptsOnly(exit.cause)
    ? printed("stopped")
    : refused(`orb provider: ${Cause.pretty(exit.cause)}`);
}

export const orbCommands: CommandNode<OrbPorts> = {
  name: "orb",
  summary: "Run the workspace container on this machine.",
  subcommands: [
    {
      name: "provider",
      summary: "Run workspace containers for the Workspace Host with a dispatch script.",
      usage: "<dispatch-script>",
      run: ([script, ...extra], ports) =>
        script === undefined || extra.length > 0
          ? undefined
          : Effect.runPromiseExit(provide(script, ports), { signal: ports.signal }).then(finished),
    },
  ],
};
