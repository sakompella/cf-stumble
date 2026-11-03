import { resolve } from "node:path";
import { printed, refused, type CommandNode, type CommandOutput } from "../tree.js";
import { OrbProvider } from "./provider.js";

export type OrbPorts = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  log(line: string): void;
}>;

const DEFAULT_LISTEN_HOST = "127.0.0.1";

function workerUrl(text: string | undefined): URL | undefined {
  const url = text === undefined ? undefined : URL.parse(text);

  return url?.protocol === "https:" || url?.protocol === "http:" ? url : undefined;
}

async function provide(script: string, ports: OrbPorts): Promise<CommandOutput> {
  const url = workerUrl(ports.env["STUMBLE_ORB_URL"]);
  const token = ports.env["STUMBLE_ORB_TOKEN"];

  if (url === undefined) return refused("set STUMBLE_ORB_URL to the Worker's http(s) URL");

  if (token === undefined || token === "")
    return refused("set STUMBLE_ORB_TOKEN to a token from POST /api/orb/provider-token");

  const provider = new OrbProvider({ url, token, script: resolve(script), log: ports.log });
  const listenHost = ports.env["STUMBLE_ORB_LISTEN_HOST"] ?? DEFAULT_LISTEN_HOST;
  const ended = await provider.run(listenHost, ports.signal);

  return ports.signal.aborted ? printed(`stopped: ${ended}`) : refused(ended);
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
        script === undefined || extra.length > 0 ? undefined : provide(script, ports),
    },
  ],
};
