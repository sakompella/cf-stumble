export type ActiveCommit = Readonly<{ harnessCommit: string | undefined; epoch: number }>;

export type Submitted =
  | Readonly<{ kind: "ready"; label: number }>
  | Readonly<{ kind: "failed"; label: number; reason: string }>
  | Readonly<{ kind: "interrupted"; reason: string }>;

export type ActivationAnswer = Readonly<{ ok: boolean; code: string | undefined }>;

export type ReleaseOwner = Readonly<{
  active: () => Promise<ActiveCommit>;
  submit: (harnessCommit: string, timeoutMs: number) => Promise<Submitted>;
  activate: (label: number, observedEpoch: number, force: boolean) => Promise<ActivationAnswer>;
}>;

export type ReleaseDeps = Readonly<{
  owner: ReleaseOwner;
  force: boolean;
  facetChangedSince: (harnessCommit: string) => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  report: (line: string) => void;
}>;

export const INTERRUPTION_DEADLINE_MS = 10 * 60_000;

export const INTERRUPTION_BACKOFF_MS = 5_000;

export const INTERRUPTION_BACKOFF_MAX_MS = 60_000;

export const RUN_ACTIVE_RETRY_MS = 15 * 60_000;

export const RUN_ACTIVE_POLL_MS = 30_000;

export class RequestInterrupted extends Error {}

type Recovery = Readonly<{
  remainingMs: () => number;
  after: (reason: string) => Promise<void>;
}>;

function recovery(target: string, deps: ReleaseDeps): Recovery {
  const deadline = deps.now() + INTERRUPTION_DEADLINE_MS;
  let interruptions = 0;

  return {
    remainingMs: () => deadline - deps.now(),
    async after(reason) {
      interruptions += 1;
      deps.report(`interruption ${interruptions}: ${reason}`);

      const pause = Math.min(
        INTERRUPTION_BACKOFF_MS * 2 ** (interruptions - 1),
        INTERRUPTION_BACKOFF_MAX_MS,
      );

      if (deps.now() + pause >= deadline) {
        throw new Error(
          `the infrastructure interrupted the release of ${target} ${interruptions} times within ${INTERRUPTION_DEADLINE_MS / 60_000} minutes; last: ${reason}`,
        );
      }

      await deps.wait(pause);
    },
  };
}

async function reaching<T>(recover: Recovery, call: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await call();
    } catch (cause) {
      if (!(cause instanceof RequestInterrupted)) throw cause;

      await recover.after(cause.message);
    }
  }
}

async function preparedLabel(
  target: string,
  deps: ReleaseDeps,
  recover: Recovery,
): Promise<number> {
  for (;;) {
    const submitted = await reaching(recover, () =>
      deps.owner.submit(target, recover.remainingMs()),
    );

    if (submitted.kind === "ready") return submitted.label;

    if (submitted.kind === "failed") {
      throw new Error(
        `generation ${submitted.label} for ${target} is not ready: ${submitted.reason}`,
      );
    }

    await recover.after(submitted.reason);
  }
}

export async function releaseGeneration(target: string, deps: ReleaseDeps): Promise<string> {
  const { owner } = deps;
  const recover = recovery(target, deps);
  const { harnessCommit: active } = await reaching(recover, () => owner.active());

  if (active === target) return `${target} is already the active generation.`;

  if (active !== undefined && !(await deps.facetChangedSince(active))) {
    return `Skipped: nothing the facet bundles changed since the active generation's ${active}.`;
  }

  const label = await preparedLabel(target, deps, recover);

  const deadline = deps.now() + RUN_ACTIVE_RETRY_MS;

  for (;;) {
    const { epoch } = await reaching(recover, () => owner.active());
    const answer = await reaching(recover, () => owner.activate(label, epoch, deps.force));

    if (answer.ok) return `Activated generation ${label} for ${target}.`;

    if (answer.code === "drops-active-commit") {
      return `Not activated: ${target} does not contain the active generation's ${active ?? "commit"}. Generation ${label} is ready; activate it with \`force: true\` to drop that commit.`;
    }

    if (answer.code === "run-active" && deps.now() >= deadline) {
      return `Not activated: a run stayed active for ${RUN_ACTIVE_RETRY_MS / 60_000} minutes. Generation ${label} is ready; activate it from the owner page.`;
    }

    if (answer.code === "run-active") await deps.wait(RUN_ACTIVE_POLL_MS);
    else if (answer.code !== "stale-epoch") {
      throw new Error(`activating generation ${label} answered ${answer.code ?? "no code"}`);
    }
  }
}
