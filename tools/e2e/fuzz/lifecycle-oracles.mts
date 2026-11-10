import { loggedEvents, mentions, type Account, type Window } from "./lifecycle-logs.mts";

const GENERATION_FAULTS = new Set(["faulted", "orphaned", "restart_limit", "session-failed"]);

const KNOWN_OUTCOMES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "unanswered",
  "replaced",
]);

export async function checkLogs(
  account: Account,
  worker: string,
  window: Window,
): Promise<readonly string[]> {
  const problems: string[] = [];
  const started = await loggedEvents(account, worker, window, "run.started");
  const settled = await loggedEvents(account, worker, window, "run.settled");
  const probation = await loggedEvents(account, worker, window, "generation.probation-failed");

  const outcomes = new Map<string, number>();

  for (const { source } of settled) {
    const key = `${source.outcome ?? "?"}/${source.errorCode ?? "-"}`;

    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);

    if (!KNOWN_OUTCOMES.has(source.outcome ?? ""))
      problems.push(`run.settled with outcome ${String(source.outcome)}`);

    if (source.outcome === "failed" && !GENERATION_FAULTS.has(source.errorCode ?? "")) {
      problems.push(`run.settled failed with errorCode ${String(source.errorCode)}`);
    }
  }

  console.error(`fuzz: run.started ${started.length}, run.settled ${settled.length}`);
  console.error(`fuzz: outcomes ${JSON.stringify([...outcomes])}`);

  if (started.length !== settled.length) {
    problems.push(`run.started ${started.length} but run.settled ${settled.length}`);
  }

  for (const { source } of probation) {
    console.error(`fuzz: probation-failed ${JSON.stringify(source)}`);

    if (source.outcome !== "failed" && source.outcome !== "interrupted") {
      problems.push(`probation rolled back on outcome ${String(source.outcome)}`);
    }

    if (source.outcome === "failed" && !GENERATION_FAULTS.has(source.errorCode ?? "")) {
      problems.push(`probation rolled back on error ${String(source.errorCode)}`);
    }
  }

  for (const needle of ["Internal error in Durable Object storage", "internal-error"]) {
    const count = await mentions(account, worker, window, needle);

    if (count > 0) problems.push(`${count} log rows mention "${needle}"`);
  }

  return problems;
}
