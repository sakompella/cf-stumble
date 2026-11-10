import type { Finding, Fuzzer } from "./context.mts";
import { fuzzGit } from "./git-fuzz.mts";
import {
  installScriptedGeneration,
  pushBranch,
  runSteps,
  scriptedCommit,
} from "./scripted-generation.mts";
import type { Owner } from "../owner-api.mts";

function installed(owner: Owner, signal: AbortSignal): Promise<boolean> {
  const probe = { tool: "bash", args: { command: "true", backend: "isolate" } } as const;

  return runSteps(owner, [probe], signal).then(
    () => true,
    () => false,
  );
}

export const fuzz: Fuzzer = async (context) => {
  const { owner, target, signal } = context;
  const token = process.env["GH_TOKEN"] ?? "";

  if (!(await installed(owner, signal))) {
    const branch = `e2e/${target.runId}-gen`;
    const sha = await scriptedCommit();

    await pushBranch(sha, branch, token);
    await installScriptedGeneration(owner, sha, branch, signal);
  }

  const report = await fuzzGit({
    seed: context.seed,
    deadline: context.deadlineMs,
    runId: target.runId,
    owner,
    github: target.github,
    token,
    signal,
  });

  context.log(
    `seed ${context.seed}: ${report.rounds} rounds, ${report.steps} comparisons, ${report.divergences.length} divergences`,
  );

  for (const [name, count] of report.classes) context.log(`${count} x ${name}`);

  return report.divergences.map((divergence): Finding => ({
    area: context.area,
    oracle: "git matches the reference",
    detail: JSON.stringify(divergence),
    reproduction: `pnpm e2e:fuzz --area git --seed ${context.seed}`,
  }));
};
