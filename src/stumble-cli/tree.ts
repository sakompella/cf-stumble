export type CommandOutput = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

type Leaf<Ports> = Readonly<{
  name: string;
  summary: string;
  usage: string;
  run(args: readonly string[], ports: Ports): Promise<CommandOutput> | undefined;
}>;

type Group<Ports> = Readonly<{
  name: string;
  summary: string;
  subcommands: readonly CommandNode<Ports>[];
}>;

export type CommandNode<Ports> = Leaf<Ports> | Group<Ports>;

const USAGE_EXIT = 2;

export function printed(stdout: string, exitCode = 0): CommandOutput {
  return { stdout: `${stdout}\n`, stderr: "", exitCode };
}

export function refused(stderr: string, exitCode = 1): CommandOutput {
  return { stdout: "", stderr: `${stderr}\n`, exitCode };
}

function isGroup<Ports>(node: CommandNode<Ports>): node is Group<Ports> {
  return "subcommands" in node;
}

function synopsis<Ports>(node: CommandNode<Ports>): string {
  return isGroup(node) ? `${node.name} <command>` : `${node.name} ${node.usage}`.trimEnd();
}

function help<Ports>(path: readonly string[], group: Group<Ports>): string {
  const width = Math.max(...group.subcommands.map((node) => synopsis(node).length));

  const rows = group.subcommands.map(
    (node) => `  ${synopsis(node).padEnd(width)}  ${node.summary}`,
  );

  return [
    `Usage: ${[...path, "<command>"].join(" ")}`,
    "",
    group.summary,
    "",
    "Commands:",
    ...rows,
  ].join("\n");
}

export function runCommandTree<Ports>(
  root: CommandNode<Ports>,
  args: readonly string[],
  ports: Ports,
): Promise<CommandOutput> {
  const path = [root.name];
  let node = root;
  let rest = args;

  while (isGroup(node)) {
    const [word, ...after] = rest;

    if (word === undefined || word === "help" || word === "--help") {
      return Promise.resolve(printed(help(path, node)));
    }

    const next = node.subcommands.find((candidate) => candidate.name === word);

    if (next === undefined) {
      const unknown = `${path.join(" ")}: unknown command '${word}'`;

      return Promise.resolve(refused(`${unknown}\n\n${help(path, node)}`, USAGE_EXIT));
    }

    path.push(next.name);
    node = next;
    rest = after;
  }

  const running = node.run(rest, ports);

  if (running === undefined) {
    const usage = `Usage: ${[...path.slice(0, -1), synopsis(node)].join(" ")}`;

    return Promise.resolve(refused(usage, USAGE_EXIT));
  }

  return running.catch(() => refused(`${path.join(" ")}: the request failed`));
}
