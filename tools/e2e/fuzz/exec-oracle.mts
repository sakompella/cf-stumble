import type { Case } from "./exec-gen.mts";
import type { Observation, Outcome, Step } from "./exec-session.mts";

export const SPILL_AFTER_BYTES = 51_200;

export const SPILL_AFTER_LINES = 2_000;

export type Variant = "isolate" | "container" | "auto";

export type CaseSteps = Readonly<{
  steps: readonly Step[];
  variants: readonly Variant[];
}>;

const STATE_COMMAND = [
  "find . -mindepth 1 | sort | xargs -d '\\n' -r sh -c",
  `'for f; do if [ -L "$f" ]; then echo "$f -> $(readlink "$f")";`,
  `elif [ -f "$f" ]; then echo "$f $(stat -c %a "$f") $(sha256sum < "$f")"; else echo "$f/"; fi; done' _`,
].join(" ");

export function caseRoot(runId: string, id: number): string {
  return `/workspace/fuzz/${runId}/c${id}`;
}

function setupCommand(item: Case, root: string, scratch: string): string {
  const lines = item.fixtures.map(
    ({ path, base64 }) =>
      `mkdir -p "$(dirname '${path}')" && echo ${base64} | base64 -d > '${path}'`,
  );

  return [`rm -rf ${root} ${scratch}`, `mkdir -p ${root}`, `cd ${root}`, ...lines].join(" && ");
}

export function stepsFor(
  runId: string,
  item: Case,
  isolateSupported: boolean,
  scratch: string,
): CaseSteps {
  const variants: readonly Variant[] = isolateSupported
    ? ["isolate", "container", "auto"]
    : ["container", "auto"];

  const root = caseRoot(runId, item.id);

  const trial = (variant: Variant): Step => {
    const base = { command: item.command.replaceAll("@T", scratch), cwd: root };
    const routed = variant === "auto" ? base : { ...base, backend: variant };

    return item.timeout === undefined ? routed : { ...routed, timeout: item.timeout };
  };

  const steps = variants.flatMap((variant): readonly Step[] => [
    { command: setupCommand(item, root, scratch), backend: "container" },
    trial(variant),
    { command: STATE_COMMAND, cwd: root, backend: "container" },
  ]);

  return { variants, steps };
}

export type Verdict = Readonly<{ problems: readonly string[] }>;

function isOutcome(observation: Observation): observation is Outcome {
  return "ok" in observation;
}

function sameText(a: Outcome["stdout"], b: Outcome["stdout"]): boolean {
  if (a.text !== null && b.text !== null) return a.text === b.text;

  return a.sha256 === b.sha256 && a.bytes === b.bytes;
}

function spillProblems(outcome: Outcome, label: string): readonly string[] {
  const { stdout, stderr, spill } = outcome;
  const bytes = stdout.bytes + stderr.bytes;
  const lines = stdout.lines + stderr.lines;
  const mustSpill = bytes > SPILL_AFTER_BYTES || lines > SPILL_AFTER_LINES;

  if (spill === null)
    return mustSpill ? [`${label}: ${bytes} bytes, ${lines} lines but no saved output`] : [];

  if (!spill.readable || spill.content === null)
    return [`${label}: saved output ${spill.path} is unreadable`];

  const matches = [stdout, stderr, undefined].some(
    (stream) =>
      (stream === undefined ? bytes : stream.bytes) === spill.content?.bytes &&
      (stream === undefined || stream.sha256 === spill.content?.sha256),
  );

  return matches
    ? []
    : [
        `${label}: saved output ${spill.path} holds ${spill.content.bytes} bytes, not the ${bytes} streamed`,
      ];
}

function show(outcome: Outcome): string {
  const out = JSON.stringify(outcome.stdout.text ?? outcome.stdout.head);
  const err = JSON.stringify(outcome.stderr.text ?? outcome.stderr.head);

  return `exit ${outcome.exitCode}/${outcome.error} out=${out} err=${err}`;
}

function outcomeDiffers(other: Outcome, container: Outcome): boolean {
  return (
    other.exitCode !== container.exitCode ||
    other.error !== container.error ||
    !sameText(other.stdout, container.stdout) ||
    (other.stderr.bytes === 0) !== (container.stderr.bytes === 0)
  );
}

function stateDiffers(own: Observation | undefined, container: Observation | undefined): boolean {
  return (
    own !== undefined &&
    container !== undefined &&
    isOutcome(own) &&
    isOutcome(container) &&
    !sameText(own.stdout, container.stdout)
  );
}

type Trial = Readonly<{ run: Observation | undefined; state: Observation | undefined }>;

function compare(label: string, own: Trial, container: Trial): readonly string[] {
  const { run, state } = own;

  if (
    run === undefined ||
    !isOutcome(run) ||
    container.run === undefined ||
    !isOutcome(container.run)
  ) {
    return [];
  }

  const problems = [...spillProblems(run, label)];

  if (label !== "container" && outcomeDiffers(run, container.run)) {
    problems.push(`${label}: ${show(run)} | container: ${show(container.run)}`);
  }

  if (label !== "container" && stateDiffers(state, container.state)) {
    problems.push(`${label}: files differ from the container's`);
  }

  return problems;
}

export function judge(variants: readonly Variant[], observed: readonly Observation[]): Verdict {
  const toolErrors = observed.flatMap((observation, index) =>
    isOutcome(observation)
      ? []
      : [`step ${index}: tool error ${observation.toolError.slice(0, 300)}`],
  );

  if (toolErrors.length > 0) return { problems: toolErrors };

  const trial = (variant: Variant): Trial => {
    const base = variants.indexOf(variant) * 3;

    return { run: observed[base + 1], state: observed[base + 2] };
  };

  const setups = variants.flatMap((_, index) => {
    const setup = observed[index * 3];

    return setup !== undefined && isOutcome(setup) && setup.exitCode !== 0
      ? [`setup exited ${setup.exitCode}/${setup.error}: ${setup.stderr.text ?? ""}`]
      : [];
  });

  const container = trial("container");

  return {
    problems: [
      ...setups,
      ...variants.flatMap((variant) => compare(variant, trial(variant), container)),
    ],
  };
}
