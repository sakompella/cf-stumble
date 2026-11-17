export type ActiveCommit = Readonly<{ harnessCommit: string | undefined; epoch: number }>;

export type Submitted = Readonly<{ label: number; ready: boolean; reason: string }>;

export type ActivationAnswer = Readonly<{ ok: boolean; code: string | undefined }>;

export type ReleaseOwner = Readonly<{
  active: () => Promise<ActiveCommit>;
  submit: (harnessCommit: string) => Promise<Submitted>;
  activate: (label: number, observedEpoch: number, force: boolean) => Promise<ActivationAnswer>;
}>;

export type ReleaseDeps = Readonly<{
  owner: ReleaseOwner;
  force: boolean;
  facetChangedSince: (harnessCommit: string) => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}>;

export const RUN_ACTIVE_RETRY_MS = 15 * 60_000;

export const RUN_ACTIVE_POLL_MS = 30_000;

export async function releaseGeneration(target: string, deps: ReleaseDeps): Promise<string> {
  const { owner } = deps;
  const { harnessCommit: active } = await owner.active();

  if (active === target) return `${target} is already the active generation.`;

  if (active !== undefined && !(await deps.facetChangedSince(active))) {
    return `Skipped: nothing the facet bundles changed since the active generation's ${active}.`;
  }

  const submitted = await owner.submit(target);

  if (!submitted.ready) {
    throw new Error(
      `generation ${submitted.label} for ${target} is not ready: ${submitted.reason}`,
    );
  }

  const deadline = deps.now() + RUN_ACTIVE_RETRY_MS;

  for (;;) {
    const { epoch } = await owner.active();
    const answer = await owner.activate(submitted.label, epoch, deps.force);

    if (answer.ok) return `Activated generation ${submitted.label} for ${target}.`;

    if (answer.code === "drops-active-commit") {
      return `Not activated: ${target} does not contain the active generation's ${active ?? "commit"}. Generation ${submitted.label} is ready; activate it with \`force: true\` to drop that commit.`;
    }

    if (answer.code === "run-active" && deps.now() >= deadline) {
      return `Not activated: a run stayed active for ${RUN_ACTIVE_RETRY_MS / 60_000} minutes. Generation ${submitted.label} is ready; activate it from the owner page.`;
    }

    if (answer.code === "run-active") await deps.wait(RUN_ACTIVE_POLL_MS);
    else if (answer.code !== "stale-epoch") {
      throw new Error(
        `activating generation ${submitted.label} answered ${answer.code ?? "no code"}`,
      );
    }
  }
}
