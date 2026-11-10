import { setTimeout as sleep } from "node:timers/promises";
import { workerName } from "../../../infra/worker-settings.ts";
import { accountFrom } from "../cloudflare.mts";
import { Ledger, readStatus, submit } from "./lifecycle-actions.mts";
import { checkLogs } from "./lifecycle-oracles.mts";
import { Probe, pollUntil } from "./lifecycle-probe.mts";
import { createRng } from "./lifecycle-rng.mts";
import { MAX_TURNS, playRound, type Aux, type RoundContext } from "./lifecycle-rounds.mts";
import { HARNESS } from "./lifecycle-turns.mts";
import type { FuzzRun } from "./stage.mts";

async function finalTurn(probe: Probe, signal: AbortSignal) {
  const before = (await probe.owner.entries(HARNESS)).at(0)?.id ?? 0;
  const requestId = crypto.randomUUID();

  const sent = await probe.http("POST", `/api/projects/${HARNESS}/messages`, {
    content: "Reply with the single word continued. Do not use any tool.",
    requestId,
  });

  if (sent.status !== 202) {
    probe.violation(`the final turn was refused: ${sent.status} ${sent.text.slice(0, 160)}`);

    return;
  }

  const answered = await pollUntil(240_000, signal, async () => {
    const entries = await probe.owner.entries(HARNESS);

    return entries.some((entry) => entry.id > before && entry.kind === "pi.assistant");
  });

  if (!answered) probe.violation("the final normal turn was not answered");
}

function pollStatus(probe: Probe, ledger: Ledger, stop: AbortSignal): Promise<void> {
  return (async () => {
    while (!stop.aborted) {
      await readStatus(probe, ledger).catch((cause: unknown) => {
        probe.note(`status poll failed: ${String(cause)}`);
      });
      await sleep(2_000, undefined, { signal: stop }).catch(() => {});
    }
  })();
}

async function rounds(run: FuzzRun, context: RoundContext, startedMs: number) {
  let turns = 0;
  let round = 0;

  while (Date.now() - startedMs < run.minutes * 60_000 && !run.signal.aborted) {
    round += 1;

    const kind = context.rng.weighted([
      ["turn", turns < MAX_TURNS ? 4 : 0],
      ["burst", 4],
      ["same-commit", 2],
      ["connect", 2],
      ["idle-reset", 1],
      ["projects", 1],
    ] as const);

    context.probe.note(`#### round ${round} ${kind}`);

    if (kind === "turn") turns += 1;

    await playRound(kind, context);

    if (context.probe.violations.length > 0) break;
  }

  return { round, turns };
}

async function verdict(run: FuzzRun, probe: Probe, startedMs: number): Promise<boolean> {
  await sleep(75_000);

  const account = accountFrom(process.env);
  const worker = workerName(run.target.stage ?? "");
  const found = await checkLogs(account, worker, { fromMs: startedMs - 5_000, toMs: Date.now() });

  for (const problem of found) probe.violation(problem);

  if (probe.violations.length > 0) {
    console.error(
      `fuzz: ${probe.violations.length} violations; first: ${probe.violations[0] ?? ""}`,
    );
    console.error(`fuzz: trace tail (seed ${run.seed})\n${probe.dump(80)}`);
  }

  return probe.violations.length === 0;
}

export async function lifecycleFuzz(run: FuzzRun): Promise<boolean> {
  const probe = new Probe(run.owner);
  const ledger = new Ledger();
  const aux: Aux = { id: undefined };
  const stop = new AbortController();
  const startedMs = Date.now();
  const commits = await run.github.mainCommits(8);

  const context: RoundContext = {
    probe,
    ledger,
    rng: createRng(run.seed),
    commits,
    aux,
    signal: AbortSignal.any([run.signal, stop.signal]),
  };

  const poller = pollStatus(probe, ledger, stop.signal);

  await readStatus(probe, ledger);

  for (const known of commits.slice(0, 1)) await submit(probe, ledger, known);

  let played = { round: 0, turns: 0 };

  try {
    played = await rounds(run, context, startedMs);

    if (probe.violations.length === 0) await finalTurn(probe, context.signal);
  } catch (cause) {
    probe.violation(
      `the fuzzer threw: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
    );
  }

  stop.abort();
  await poller;
  console.error(`fuzz: ${played.round} rounds, ${played.turns} turns, seed ${run.seed}`);
  console.error(
    [...probe.counts]
      .map(([key, count]) => `${count} x ${key}`)
      .toSorted()
      .join("\n"),
  );

  if (aux.id !== undefined) await run.owner.disconnect(aux.id).catch(() => {});

  return verdict(run, probe, startedMs);
}
