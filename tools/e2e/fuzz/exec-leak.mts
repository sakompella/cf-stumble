import { runSteps, type Step } from "./exec-session.mts";
import type { FuzzContext as FuzzRun } from "./context.mts";

const PID_FILE = "/tmp/fuzz-leak.pid";

const LEAKING: Step = {
  command: `sleep 600 & echo $! > ${PID_FILE}; wait`,
  backend: "container",
  timeout: 3,
};

const SURVIVOR: Step = {
  command: `sleep 2; if kill -0 "$(cat ${PID_FILE})" 2>/dev/null; then echo ALIVE; else echo GONE; fi`,
  backend: "container",
};

export async function leakProblems(run: FuzzRun): Promise<readonly string[]> {
  const [leaking, survivor] = await runSteps(run, [LEAKING, SURVIVOR]);

  if (leaking === undefined || survivor === undefined) return ["leak check: a step is missing"];

  if (!("ok" in survivor)) return [`leak check: tool error ${survivor.toolError.slice(0, 200)}`];

  if (survivor.stdout.text?.trim() === "GONE") return [];

  return [
    `a container command killed at its timeout left its child running: ${survivor.stdout.text}`,
  ];
}
