import { runCommandTree, type CommandNode } from "../tree.js";
import { orbCommands, type OrbPorts } from "./commands.js";

const stumble: CommandNode<OrbPorts> = {
  name: "stumble",
  summary: "cf-stumble's commands for a machine that runs workspace containers.",
  subcommands: [orbCommands],
};

const stopping = new AbortController();

const stop = (): void => {
  stopping.abort();
};

process.once("SIGINT", stop);

process.once("SIGTERM", stop);

const output = await runCommandTree(stumble, process.argv.slice(2), {
  env: process.env,
  signal: stopping.signal,
  platform: process.platform,
  arch: process.arch,
  log: (line) => {
    console.error(`${new Date().toISOString()} ${line}`);
  },
});

process.stdout.write(output.stdout);

process.stderr.write(output.stderr);

process.exitCode = output.exitCode;
