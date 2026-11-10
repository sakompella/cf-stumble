import { randomBytes } from "node:crypto";
import type { GitHub } from "../github.mts";
import type { Owner } from "../owner-api.mts";
import { parseBash } from "./bash-result.mts";
import { Generator } from "./git-cases.mts";
import { signature, type Case } from "./git-data.mts";
import { classify, describe, matches, normalize, type Divergence } from "./git-compare.mts";
import { Oracle, probe, WORKSPACE_DIRECTORY, type Outcome } from "./git-oracle.mts";
import { branchTree } from "./github-tree.mts";
import { runSteps, type Step } from "./scripted-generation.mts";

const BATCH = 24;

const ROUND_STEPS = 72;

export type FuzzOptions = Readonly<{
  seed: number;
  deadline: number;
  runId: string;
  owner: Owner;
  github: GitHub;
  token: string;
  signal: AbortSignal;
}>;

type Planned = Readonly<{
  label: string;
  item: Case | undefined;
  step: Step;
  oracle: () => Promise<Outcome>;
}>;

export type Report = Readonly<{
  rounds: number;
  steps: number;
  divergences: readonly Divergence[];
  classes: ReadonlyMap<string, number>;
}>;

function bash(directory: string, command: string, backend: string): Step {
  return { tool: "bash", args: { command: `cd ${directory} && ${command}`, backend } };
}

function plan(item: Case, directory: string, oracle: Oracle, index: number): readonly Planned[] {
  const main: Planned = {
    label: "step",
    item,
    step: bash(directory, item.command, item.backend),
    oracle: () => oracle.runCase(item),
  };

  if (item.kind === "read" && index % 4 !== 0) return [main];

  const real = probe("/usr/bin/git", true);
  const local = probe("git", true);
  const narrow = probe("git", false);

  return [
    main,
    {
      label: "container-probe",
      item: undefined,
      step: bash(directory, real, "container"),
      oracle: () => oracle.inRepository(local),
    },
    {
      label: "isolate-probe",
      item: undefined,
      step: bash(directory, narrow, "isolate"),
      oracle: () => oracle.inRepository(narrow),
    },
  ];
}

async function checkRemote(
  options: FuzzOptions,
  oracle: Oracle,
  branches: readonly string[],
): Promise<string[]> {
  const found: string[] = [];

  for (const branch of branches) {
    const expected = await oracle.remoteTree(branch);
    const actual = await branchTree(options.token, branch);

    if (expected !== actual) found.push(`${branch}: oracle ${expected}, GitHub ${actual}`);
  }

  return found;
}

function known(item: Case): string {
  return `${item.kind}:${signature(item.command)}`;
}

class Session {
  readonly divergences: Divergence[] = [];
  readonly classes = new Map<string, number>();
  readonly #seen = new Set<string>();
  readonly #options: FuzzOptions;
  readonly #salt = randomBytes(2).toString("hex");
  steps = 0;
  rounds = 0;

  constructor(options: FuzzOptions) {
    this.#options = options;
  }

  get active(): boolean {
    return Date.now() < this.#options.deadline && !this.#options.signal.aborted;
  }

  async round(): Promise<void> {
    this.rounds += 1;

    const tag = `${this.#options.runId}-${this.#salt}-r${this.rounds}`;
    const directory = `${WORKSPACE_DIRECTORY}/${tag}`;
    const generator = new Generator(this.#options.seed * 1000 + this.rounds, tag);
    const oracle = new Oracle(tag);

    const cases = [
      ...generator.setup(),
      ...Array.from({ length: ROUND_STEPS }, () =>
        generator.next((item) => this.#seen.has(known(item))),
      ),
    ];

    await oracle.start();
    await runSteps(
      this.#options.owner,
      [bash("/workspace", `mkdir -p ${directory}`, "isolate")],
      this.#options.signal,
    );

    try {
      await this.#replay(cases, directory, oracle);

      for (const line of await checkRemote(this.#options, oracle, generator.pushedBranches())) {
        console.error(`fuzz git: remote divergence round ${this.rounds}: ${line}`);
      }
    } finally {
      oracle.stop();
    }
  }

  async #replay(cases: readonly Case[], directory: string, oracle: Oracle): Promise<void> {
    for (let index = 0; index < cases.length; index += BATCH) {
      const planned = cases
        .slice(index, index + BATCH)
        .flatMap((item, offset) => plan(item, directory, oracle, index + offset));

      const results = await runSteps(
        this.#options.owner,
        planned.map((entry) => entry.step),
        this.#options.signal,
      );

      for (const [position, entry] of planned.entries()) {
        if (await this.#compare(entry, parseBash(results[position] ?? ""), oracle, index)) return;
      }
    }
  }

  async #compare(entry: Planned, stage: Outcome, oracle: Oracle, index: number): Promise<boolean> {
    const expected = await entry.oracle();
    const roots = [oracle.root];
    const left = { ...expected, output: normalize(expected.output, entry.item, roots) };
    const right = { ...stage, output: normalize(stage.output, entry.item, roots) };

    this.steps += 1;

    if (matches(left, right)) return false;

    const found: Divergence = {
      round: this.rounds,
      index,
      label: entry.label,
      kind: entry.item?.kind ?? "probe",
      command: entry.item?.command ?? "probe",
      oracle: left,
      stage: right,
    };

    const name = classify(found);

    this.divergences.push(found);
    this.classes.set(name, (this.classes.get(name) ?? 0) + 1);

    if (entry.item !== undefined) this.#seen.add(known(entry.item));

    console.error(`fuzz git: DIVERGENCE\n${describe(found)}`);

    return true;
  }
}

export async function fuzzGit(options: FuzzOptions): Promise<Report> {
  const session = new Session(options);

  while (session.active) await session.round();

  return {
    rounds: session.rounds,
    steps: session.steps,
    divergences: session.divergences,
    classes: session.classes,
  };
}

export function newRunId(): string {
  return randomBytes(4).toString("hex");
}
