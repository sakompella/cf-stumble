import type { Probe, Reply } from "./lifecycle-probe.mts";
import type { Rng } from "./lifecycle-rng.mts";

type Known = Readonly<{ label: number; ready: boolean }>;

export class Ledger {
  readonly commits = new Map<string, Known>();
  readonly labels = new Map<number, string>();
  lastEpoch = -1;
}

export async function readStatus(
  probe: Probe,
  ledger: Ledger,
): Promise<Readonly<{ epoch: number; label: number | undefined }> | null> {
  const reply = await probe.http("GET", "/api/status");

  if (reply.status !== 200) {
    probe.violation(`status answered ${reply.status}`);

    return null;
  }

  const epoch = reply.doc.activeGeneration?.epoch;
  const generation = reply.doc.activeGeneration?.generation;
  const label = generation?.label;
  const commit = generation?.harnessCommit;
  const status = generation?.status;

  if (epoch === undefined) {
    probe.violation(`status has no epoch: ${reply.text.slice(0, 200)}`);

    return null;
  }

  if (epoch < ledger.lastEpoch)
    probe.violation(`epoch went back from ${ledger.lastEpoch} to ${epoch}`);

  ledger.lastEpoch = Math.max(ledger.lastEpoch, epoch);

  if (label !== undefined && status !== "ready") {
    probe.violation(`active generation ${label} has status ${String(status)}`);
  }

  if (label !== undefined && commit !== undefined) {
    const seen = ledger.labels.get(label);

    if (seen !== undefined && seen !== commit) {
      probe.violation(`label ${label} maps to ${seen} and then ${commit}`);
    }

    ledger.labels.set(label, commit);
  }

  return { epoch, label };
}

export async function submit(probe: Probe, ledger: Ledger, commit: string): Promise<Reply> {
  const reply = await probe.http("POST", "/api/generations/submit", { harnessCommit: commit });
  const label = reply.doc.outcome?.generation?.label;

  if (reply.status === 200 && label !== undefined) {
    const ready = reply.doc.preparation?.report?.stage === "ready";
    const before = ledger.commits.get(commit);

    if (before !== undefined && before.label !== label) {
      probe.violation(`commit ${commit} got label ${before.label} and then ${label}`);
    }

    const owner = ledger.labels.get(label);

    if (owner !== undefined && owner !== commit) {
      probe.violation(`label ${label} given to ${commit} and ${owner}`);
    }

    ledger.labels.set(label, commit);
    ledger.commits.set(commit, { label, ready: ready || before?.ready === true });
  } else if (reply.status === 200) {
    probe.violation(`submit answered 200 without a label: ${reply.text.slice(0, 200)}`);
  }

  return reply;
}

const REFUSALS = new Set([
  "unknown-generation",
  "stale-epoch",
  "not-ready",
  "not-previously-active",
  "facet-compatibility-mismatch",
  "run-active",
  "drops-active-commit",
]);

export type EpochMode = "fresh" | "stale" | "future";

function observedEpoch(mode: EpochMode, epoch: number, rng: Rng): number {
  if (mode === "fresh") return epoch;

  return mode === "stale" ? Math.max(0, epoch - 1 - rng.int(3)) : epoch + 1000;
}

export async function control(
  probe: Probe,
  ledger: Ledger,
  rng: Rng,
  kind: "activate" | "rollback",
  label: number,
  mode: EpochMode,
): Promise<void> {
  const before = await readStatus(probe, ledger);

  if (before === null) return;

  const effective: EpochMode = mode === "stale" && before.epoch === 0 ? "fresh" : mode;
  const observed = observedEpoch(effective, before.epoch, rng);

  const reply = await probe.http("POST", `/api/generations/${kind}`, {
    label,
    observedEpoch: observed,
  });

  const code = reply.doc.problem?.code;

  if (reply.status === 200) {
    if (effective !== "fresh") {
      probe.violation(
        `${kind} ${label} with ${effective} epoch ${observed} (status ${before.epoch}) succeeded`,
      );
    }

    const epoch = reply.doc.outcome?.epoch;
    const effect = reply.doc.outcome?.effect;

    if (epoch === undefined || effect === undefined) probe.violation(`${kind} ok without outcome`);
    else if (effect === "activated" && epoch <= before.epoch) {
      probe.violation(`${kind} ${label} activated at epoch ${epoch} after ${before.epoch}`);
    }

    await readStatus(probe, ledger);

    return;
  }

  if (reply.status < 500 && (code === undefined || !REFUSALS.has(code))) {
    probe.violation(
      `${kind} ${label} answered ${reply.status} without a known refusal: ${reply.text.slice(0, 160)}`,
    );
  }

  if (
    effective !== "fresh" &&
    code !== "stale-epoch" &&
    code !== "unknown-generation" &&
    code !== "run-active"
  ) {
    probe.violation(`${kind} ${label} with ${effective} epoch refused as ${String(code)}`);
  }
}

export async function hostileControl(probe: Probe, rng: Rng): Promise<void> {
  const kind = rng.pick(["activate", "rollback"]);

  const bodies = [
    '{"label":-1,"observedEpoch":0}',
    '{"label":1.5,"observedEpoch":0}',
    '{"label":"0","observedEpoch":0}',
    '{"label":9007199254740992,"observedEpoch":0}',
    '{"label":0}',
    '{"observedEpoch":3}',
    "[]",
    "null",
    "{not json",
    "",
    '{"label":0,"observedEpoch":1e400}',
  ];

  const raw = rng.pick(bodies);
  const reply = await probe.http("POST", `/api/generations/${kind}`, undefined, raw);

  if (reply.status >= 200 && reply.status < 300)
    probe.violation(`hostile ${kind} body accepted: ${raw}`);
}

export async function hostileSubmit(probe: Probe, rng: Rng): Promise<void> {
  const commits = [
    "",
    "main",
    "HEAD",
    "0".repeat(40),
    "f".repeat(64),
    "F".repeat(40),
    rng.hex(39),
    rng.hex(41),
    `${rng.hex(40)}\n`,
    "--upload-pack=x",
    `${rng.hex(20)}; rm -rf /`,
    "../".repeat(5),
  ];

  const reply = await probe.http("POST", "/api/generations/submit", {
    harnessCommit: rng.pick(commits),
  });

  if (reply.status === 200 && reply.doc.preparation?.report?.stage === "ready") {
    probe.violation(`a hostile commit became ready: ${reply.text.slice(0, 200)}`);
  }
}
