import { invariant } from "./invariant.js";
import { shellQuote } from "./shell-quote.js";
import type { Project, ProjectId } from "./project-catalog.js";

/**
 * Where one catalog project's repository lands in its own Computer workspace, and where the
 * managed agent instructions go.
 *
 * `agentInstructionsPath` sits above `projectRoot` on purpose. The clone owns the project root, so
 * a managed file written inside it would either overwrite a repository that keeps its own
 * `AGENTS.md` or show up as a working-tree change in the diff the user reviews. A sibling of the
 * root is the nearest place an agent that walks up from its working directory still reaches, and
 * it never becomes part of the repository.
 *
 * This module is shared by the workspace that provisions and the caller that asks for it, so both
 * plan a project the same way. It holds plain values only, and imports no platform API.
 */
export type ProjectProvisionConfiguration = Readonly<{
  projectRoot: string;
  projectGitDir: string;
  agentInstructionsPath: string;
}>;

/** The one project layout the Workspace Host offers and its caller plans against. */
export const PROJECT_PROVISION_CONFIGURATION = {
  projectRoot: "/project",
  projectGitDir: "/project/.git",
  agentInstructionsPath: "/AGENTS.md",
} as const satisfies ProjectProvisionConfiguration;

/**
 * The instructions cf-stumble manages for every project workspace. The second paragraph is the
 * instruction ADR-0039 requires, because that ADR is what grants the workspace a shell, ordinary
 * development tools, and unrestricted egress.
 */
export const MANAGED_AGENT_INSTRUCTIONS = [
  "# cf-stumble managed instructions",
  "",
  "cf-stumble writes this file when it provisions the workspace and rewrites it on every restart.",
  "Record project conventions in the repository instead; an edit here does not survive.",
  "",
  "`git`, `gh`, and internet access are available. Use them as needed, following the user's request",
  "and the repository's conventions. Never print or commit authentication tokens.",
  "",
].join("\n");

export type ProjectProvisionStepName = "clone" | "instructions";

/**
 * One provisioning step. The two steps do different kinds of work: cloning needs a shell, and the
 * instructions are a file whose content the server decides, so writing them through the
 * filesystem keeps the managed text out of any command line.
 */
export type ProjectProvisionStep =
  | Readonly<{ name: "clone"; source: string; cwd: string }>
  | Readonly<{ name: "instructions"; path: string; content: string }>;

export type ProjectProvisionPlan = Readonly<{
  projectId: ProjectId;
  steps: readonly [ProjectProvisionStep, ...ProjectProvisionStep[]];
}>;

/** Ordered, because a caller runs the whole plan and a reader should see the order in one place. */
export const PROJECT_PROVISION_STEP_NAMES: readonly ProjectProvisionStepName[] = [
  "clone",
  "instructions",
];

/**
 * Reconcile the project root against the repository the catalog names for this project.
 *
 * Reconciling means "a clone of the expected remote is here", never "the working tree matches
 * origin". A project workspace is a development machine (ADR-0039), so the user's uncommitted work
 * lives in that tree and a restart must not touch it. An existing clone is therefore only checked,
 * and a mismatched origin fails the step instead of being repaired, because replacing the tree is
 * how a restart would silently delete work.
 *
 * A clone lands in a fixed staging directory and is moved into place only after it succeeds, so an
 * interrupted run leaves the previous state rather than a half-populated project root that the
 * next run would read as a repository. The staging name is fixed rather than per-process so the
 * next run clears what a killed run left behind.
 *
 * The lock serializes the ordinary case; it is not airtight, since a process can hold the
 * directory for a moment before it records its own pid. Two concurrent runs can then both reach
 * the clone, one loses its staging directory, and its step fails and is retried. Converging on the
 * project root itself is what the staged move protects.
 *
 * Every value the shell sees goes through `shellQuote`. The repository URL is a
 * `PublicRepositoryUrl` from the catalog, never request data, but a URL is the one value here that
 * is configuration rather than a constant, and hand-written escaping is what turns a quoting
 * helper into an injection.
 */
function cloneProjectRepository(
  configuration: ProjectProvisionConfiguration,
  repositoryUrl: string,
): string {
  const lock = `${configuration.projectRoot}.provision-lock`;
  const staging = `${configuration.projectRoot}.provisioning`;
  return [
    "set -eu",
    `lock=${shellQuote(lock)}`,
    `repository=${shellQuote(configuration.projectRoot)}`,
    `git_dir=${shellQuote(configuration.projectGitDir)}`,
    `staging=${shellQuote(staging)}`,
    `expected_remote=${shellQuote(repositoryUrl)}`,
    'while ! mkdir "$lock" 2>/dev/null; do',
    '  owner="$(cat "$lock/pid" 2>/dev/null || true)"',
    '  if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then',
    '    stale_lock="${lock}.stale.$$"',
    '    if mv "$lock" "$stale_lock" 2>/dev/null; then',
    '      rm -rf "$stale_lock"',
    "    fi",
    "  else",
    "    sleep 1",
    "  fi",
    "done",
    'printf "%s\\n" "$$" > "$lock/pid"',
    'trap \'rm -rf "$lock" "$staging"\' EXIT',
    'if ! test "$(git --git-dir="$git_dir" rev-parse --is-bare-repository 2>/dev/null)" = false; then',
    '  rm -rf "$staging"',
    '  git clone "$expected_remote" "$staging"',
    '  rm -rf "$repository"',
    '  mv "$staging" "$repository"',
    "fi",
    'actual_remote="$(git --git-dir="$git_dir" config --get-all remote.origin.url || true)"',
    'test "$actual_remote" = "$expected_remote"',
  ].join("\n");
}

/**
 * Plan the whole of one project's provisioning. The plan is derived from the configuration and the
 * catalog project alone, so two runs for one project produce the same steps and a resumed run asks
 * for exactly what the interrupted one did.
 */
export function planProjectProvision(
  configuration: ProjectProvisionConfiguration,
  project: Project,
): ProjectProvisionPlan {
  return {
    projectId: project.id,
    steps: [
      {
        name: "clone",
        source: cloneProjectRepository(configuration, project.repositoryUrl),
        // The clone replaces the project root, so it cannot run inside it.
        cwd: "/",
      },
      {
        name: "instructions",
        path: configuration.agentInstructionsPath,
        content: MANAGED_AGENT_INSTRUCTIONS,
      },
    ],
  };
}

/** The named step of a project's provisioning plan, rather than one found by its command text. */
export function projectProvisionStep(
  plan: ProjectProvisionPlan,
  name: ProjectProvisionStepName,
): ProjectProvisionStep {
  const step = plan.steps.find((planned) => planned.name === name);
  invariant(step !== undefined, `the provisioning plan must contain its own ${name} step`);
  return step;
}
