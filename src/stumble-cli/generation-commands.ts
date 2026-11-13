import type { GenerationControl } from "../generation-requests.js";
import { isHarnessCommit } from "../harness-commit.js";
import { failureText, printed, refused, type CommandNode, type CommandOutput } from "./tree.js";

export type GenerationPorts = Readonly<{ generations: GenerationControl }>;

function count(word: string | undefined): number | undefined {
  return word !== undefined && /^\d+$/u.test(word) && Number.isSafeInteger(Number(word))
    ? Number(word)
    : undefined;
}

function epochTarget(args: readonly string[]) {
  const [labelWord, flag, epochWord, ...extra] = args;
  const label = count(labelWord);
  const observedEpoch = count(epochWord);

  return label === undefined ||
    observedEpoch === undefined ||
    flag !== "--epoch" ||
    extra.length > 0
    ? undefined
    : { label, observedEpoch };
}

async function status({ generations }: GenerationPorts): Promise<CommandOutput> {
  const { generation, epoch } = await generations.generationStatus();

  return printed(
    generation === null
      ? `no active generation, epoch ${epoch}`
      : `active generation ${generation.label} at ${generation.harnessCommit} (${generation.status}), epoch ${epoch}`,
  );
}

async function prepare(harnessCommit: string, ports: GenerationPorts): Promise<CommandOutput> {
  const { generation } = await ports.generations.submitGeneration(harnessCommit);
  const submitted = `submitted generation ${generation.label} for ${harnessCommit}`;

  return startupCheck(generation.label, submitted, ports).catch((cause: unknown) =>
    refused(`${submitted}\ngeneration ${generation.label} was not prepared: ${failureText(cause)}`),
  );
}

async function startupCheck(
  label: number,
  submitted: string,
  { generations }: GenerationPorts,
): Promise<CommandOutput> {
  const checked = await generations.prepareGeneration(label);

  if (!checked.ok) {
    return refused(`${submitted}\ngeneration ${label} was not prepared: ${checked.problem.code}`);
  }

  const { stage, reason } = checked.report;

  if (stage !== "ready") {
    return refused(
      `${submitted}\ngeneration ${label} failed its startup check (${stage}): ${reason}`,
    );
  }

  const { epoch } = await generations.generationStatus();

  return printed(
    [
      submitted,
      `generation ${label} is ready`,
      `activate it with: stumble gen activate ${label} --epoch ${epoch}`,
    ].join("\n"),
  );
}

async function control(
  kind: "activate" | "rollback",
  target: Readonly<{ label: number; observedEpoch: number }>,
  { generations }: GenerationPorts,
): Promise<CommandOutput> {
  const result = await generations.controlGeneration({ kind, ...target });

  if (result.ok) {
    const { generation, epoch, effect, droppedCommit } = result.outcome;

    const activated =
      effect === "no-op"
        ? `generation ${generation.label} is already active, epoch ${epoch}`
        : `generation ${generation.label} is now active, epoch ${epoch}`;

    return printed(
      droppedCommit === undefined
        ? activated
        : `warning: ${generation.harnessCommit} does not contain ${droppedCommit}, the commit of the generation it replaced; changes only in that commit are no longer served\n${activated}`,
    );
  }

  const current = await generations.generationStatus();

  if (current.generation?.label === target.label) {
    return printed(`generation ${target.label} is already active, epoch ${current.epoch}`);
  }

  return refused(`${kind} refused: ${result.problem.code} (current epoch ${current.epoch})`);
}

export const generationCommands: CommandNode<GenerationPorts> = {
  name: "gen",
  summary: "Inspect and change the generation that serves conversations.",
  subcommands: [
    {
      name: "status",
      summary: "Show the active generation and the selection epoch.",
      usage: "",
      run: (args, ports) => (args.length === 0 ? status(ports) : undefined),
    },
    {
      name: "prepare",
      summary: "Submit a pushed harness commit and run its startup check.",
      usage: "<commit-sha>",
      run: ([commit, ...extra], ports) =>
        commit !== undefined && isHarnessCommit(commit) && extra.length === 0
          ? prepare(commit, ports)
          : undefined,
    },
    {
      name: "activate",
      summary: "Serve a ready generation; the epoch must match status.",
      usage: "<label> --epoch <n>",
      run: (args, ports) => {
        const target = epochTarget(args);

        return target === undefined ? undefined : control("activate", target, ports);
      },
    },
    {
      name: "rollback",
      summary: "Serve a generation that was active before; the epoch must match status.",
      usage: "<label> --epoch <n>",
      run: (args, ports) => {
        const target = epochTarget(args);

        return target === undefined ? undefined : control("rollback", target, ports);
      },
    },
  ],
};
