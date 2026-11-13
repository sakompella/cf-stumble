import * as Effect from "effect/Effect";
import { logRedactedCause } from "../../diagnostics.js";
import { parseHarnessCommit, type HarnessCommit } from "../../harness-commit.js";
import { WORKSPACE_SHORT_COMMAND_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import { HARNESS_GIT_DIRECTORY, WORKSPACE_ROOT } from "../../workspace-layout.js";
import { answerFailures, type WorkspaceEffects } from "../operations.js";

export type HarnessLineageRequest = Readonly<{ activeCommit: string; harnessCommit: string }>;

export type HarnessLineage = Readonly<{
  containsActive: boolean | undefined;
  mainAheadOfActive: number | undefined;
  mainAheadOfTarget: number | undefined;
}>;

export const UNKNOWN_LINEAGE: HarnessLineage = {
  containsActive: undefined,
  mainAheadOfActive: undefined,
  mainAheadOfTarget: undefined,
};

const MAIN = "refs/remotes/origin/main";

function lineageSource(active: HarnessCommit, target: HarnessCommit): string {
  const git = `git --git-dir=${HARNESS_GIT_DIRECTORY}`;

  return [
    `if ${git} merge-base --is-ancestor ${active} ${target} 2>/dev/null; then echo "contains 0"`,
    `elif ${git} merge-base ${active} ${target} >/dev/null 2>&1; then echo "contains 1"`,
    'else echo "contains unknown"; fi',
    `echo "active $(${git} rev-list --count ${active}..${MAIN} 2>/dev/null)"`,
    `echo "target $(${git} rev-list --count ${target}..${MAIN} 2>/dev/null)"`,
  ].join("\n");
}

function field(stdout: string, name: string): string | undefined {
  return new RegExp(`^${name} (\\d+)$`, "mu").exec(stdout)?.[1];
}

function count(text: string | undefined): number | undefined {
  return text === undefined ? undefined : Number(text);
}

function parseLineage(stdout: string): HarnessLineage {
  const contains = /^contains ([01])$/mu.exec(stdout)?.[1];

  return {
    containsActive: contains === undefined ? undefined : contains === "0",
    mainAheadOfActive: count(field(stdout, "active")),
    mainAheadOfTarget: count(field(stdout, "target")),
  };
}

export function readHarnessLineage(
  operations: WorkspaceEffects,
  request: HarnessLineageRequest,
): Effect.Effect<HarnessLineage> {
  const active = parseHarnessCommit(request.activeCommit);
  const target = parseHarnessCommit(request.harnessCommit);

  if (active === undefined || target === undefined) return Effect.succeed(UNKNOWN_LINEAGE);

  return operations
    .runCommand(lineageSource(active, target), WORKSPACE_ROOT, WORKSPACE_SHORT_COMMAND_TIMEOUT_MS)
    .pipe(
      Effect.map((output) => parseLineage(output.stdout)),
      answerFailures((cause) => {
        logRedactedCause("workspace.harness-lineage: unknown", cause);

        return UNKNOWN_LINEAGE;
      }),
    );
}
