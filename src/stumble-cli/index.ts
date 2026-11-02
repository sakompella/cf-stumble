import { generationCommands, type GenerationPorts } from "./generation-commands.js";
import { runCommandTree, type CommandNode, type CommandOutput } from "./tree.js";

export type { CommandOutput } from "./tree.js";

export type StumblePorts = GenerationPorts;

const stumble: CommandNode<StumblePorts> = {
  name: "stumble",
  summary: "cf-stumble's own commands.",
  subcommands: [generationCommands],
};

export function runStumble(args: readonly string[], ports: StumblePorts): Promise<CommandOutput> {
  return runCommandTree(stumble, args, ports);
}
