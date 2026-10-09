import { invariant } from "./invariant.js";
import { shellQuote } from "./shell-quote.js";
import {
  MANAGED_AGENT_INSTRUCTIONS_PATH,
  PROJECTS_DIRECTORY,
  projectDirectory,
  projectGitDirectory,
} from "./workspace-layout.js";
import type { Project, ProjectId } from "./project-catalog.js";
import {
  durableGitHubConfigurationSource,
  REPOSITORY_SIZE_VERDICT_FUNCTION,
  repositorySizeVerdictSource,
} from "./github/index.js";

/**
 * Keep enough recent history for ordinary `git log -n` and local review, while leaving older
 * history available through an explicit `git fetch`. Blob filtering keeps the durable clone small;
 * Git fetches a blob only when a command needs it.
 */
export const PROJECT_CLONE_DEPTH = 50;

/**
 * Exit code reserved for a clone rejected for size: the workspace ran out of disk, or the size
 * check the clone runs first found the repository over a workspace ceiling.
 */
export const PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE = 122;

/** Prefix emitted only by the clone shell so its caller can record durable size without a path. */
export const PROJECT_CLONE_SIZE_MARKER = "cf-stumble-clone-size-kb=";

/**
 * The instructions cf-stumble manages for the shared workspace. The second paragraph is the
 * instruction ADR-0039 requires, because that ADR is what grants the workspace a shell, ordinary
 * development tools, and unrestricted egress.
 */
export const MANAGED_AGENT_INSTRUCTIONS = [
  "# cf-stumble managed instructions",
  "",
  "cf-stumble writes this file when it provisions the workspace and rewrites it on every restart.",
  "Record project conventions in the repository instead; an edit here does not survive.",
  "",
  "Never install dependencies or create large generated trees (node_modules, build output, virtualenvs) inside /workspace.",
  "To run a project's checks, copy the project without its dependency directories to container-local scratch such as /tmp/cf-stumble-checks/<project>, then install dependencies and run the checks there.",
  "For example: mkdir -p /tmp/cf-stumble-checks/<project> && tar -C /workspace/projects/<project> --exclude=node_modules -cf - . | tar -C /tmp/cf-stumble-checks/<project> -xf - && cd /tmp/cf-stumble-checks/<project> && npm install && npm test",
  "The workspace is durable storage, and large trees make it unresponsive.",
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
 * One project's provision lock, taken by the clone step and by project removal. The id alphabet is
 * letters, digits, and `-`, so the name is safe in a path, and one project's lock never orders
 * another project's work.
 */
export function projectProvisionLockPath(projectId: ProjectId): string {
  return `/tmp/cf-stumble-project-${projectId}.provision.lock`;
}

/**
 * Shell lines that hold a provision lock for the rest of the command: a kernel `flock` on the file
 * named by `$lock`, which the caller sets first and keeps in the container's own `/tmp`.
 *
 * Nothing records a pid, so there is no stale owner to detect or take over. The kernel releases the
 * lock when the last process holding the descriptor exits, and a container restart ends every such
 * process. The file stays out of `/workspace`, which Computer copies to and from its store, so that
 * copying cannot replace the file that holders and contenders lock. Nothing deletes it: a waiter
 * that locked a deleted file would not exclude a newcomer that created a fresh one.
 *
 * Descriptor 9 stays open in the shell and in every process it starts. The pinned computerd runner
 * signals only the direct shell (see `processGroupCommand`), and a provision step does not run
 * through that wrapper, so a `git clone` or `rm` that outlives a killed shell keeps the lock until
 * it exits too.
 */
export function holdProvisionLock(): readonly string[] {
  return ['exec 9>"$lock"', "flock 9"];
}

const CLONE_INTO_STAGING = `git clone --filter=blob:none --depth=${PROJECT_CLONE_DEPTH} --single-branch "$expected_remote" "$staging"`;

/**
 * Under the provision lock, make `$repository` a clone of `$expected_remote` whose Git directory is
 * `$git_dir`. The caller sets those variables, `$lock`, and `$staging` first. The harness checkout
 * and every project clone use this one block.
 *
 * Reconciling means "a clone of the expected remote is here", never "the working tree matches
 * origin". The workspace is a development machine (ADR-0039), so the user's uncommitted work and
 * unpushed commits live in that tree and a restart or build must not touch it. An existing clone is
 * therefore only checked, and a mismatched origin fails the step.
 *
 * Nothing here deletes a directory it did not create. A populated directory that is not a Git
 * repository fails the step and is left exactly as it was found: deleting it is how a restart
 * would silently destroy work, and this step cannot tell salvage from rubbish. The clone lands in
 * the staging directory and moves into place only after it succeeds, so an interrupted run leaves
 * the previous state rather than a half-populated root that the next run would read as a
 * repository. The staging name is fixed rather than per-process, and the `EXIT` trap is set only
 * once the lock is held, so the next run clears what a killed run left behind in the durable
 * workspace. `rmdir` removes the root only when it is an empty directory, which is the one case
 * where there is nothing to lose.
 *
 * `beforeClone` runs only when a new clone is needed. `cloneIntoStaging` replaces the plain clone
 * command, for a caller that maps a clone failure to its own exit code.
 */
export function reconcileClone(
  steps: Readonly<{ beforeClone?: readonly string[]; cloneIntoStaging?: readonly string[] }> = {},
): readonly string[] {
  const { beforeClone = [], cloneIntoStaging = [`  ${CLONE_INTO_STAGING}`] } = steps;

  return [
    ...holdProvisionLock(),
    "trap 'rm -rf \"$staging\"' EXIT",
    'if ! test "$(git --git-dir="$git_dir" rev-parse --is-bare-repository 2>/dev/null)" = false; then',
    '  if test -e "$repository" && test -n "$(ls -A "$repository" 2>/dev/null)"; then',
    '    printf "%s is not a git repository and is not empty\\n" "$repository" >&2',
    "    exit 1",
    "  fi",
    ...beforeClone,
    '  rm -rf "$staging"',
    ...cloneIntoStaging,
    '  git -C "$staging" config core.fileMode false',
    '  rmdir "$repository" 2>/dev/null || true',
    '  mv "$staging" "$repository"',
    "fi",
    'actual_remote="$(git --git-dir="$git_dir" config --get-all remote.origin.url || true)"',
    'test "$actual_remote" = "$expected_remote"',
  ];
}

/**
 * Reconcile the project directory against the repository the catalog names for this project, with
 * the shared clone block (`reconcileClone`).
 *
 * The project's provision lock (`projectProvisionLockPath`) orders this step with other clone
 * steps and with project removal for the same project. Commands a turn runs do not take it.
 * Restarting one project reads and writes only that project's own directory, so it cannot reclone
 * or overwrite another.
 *
 * Before a new clone, the step measures the repository with the workspace's own `gh` credential
 * (`github/repository-size-guard.ts`) and refuses one over a workspace ceiling. This is the check
 * that covers a private repository the Supervisor's `GH_TOKEN` preflight cannot see, and a clone
 * recreated after a reset from a repository that has grown since it was connected. A repository it
 * cannot measure is cloned anyway. An existing clone is never measured or removed.
 *
 * Every value the shell sees goes through `shellQuote`. The repository URL is a
 * `PublicRepositoryUrl` from the catalog, never request data, but a URL is the one value here that
 * is configuration rather than a constant, and hand-written escaping is what turns a quoting
 * helper into an injection.
 */
function cloneProjectRepository(project: Project): string {
  const { repositoryUrl } = project;
  const root = projectDirectory(project.id);

  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    `projects=${shellQuote(PROJECTS_DIRECTORY)}`,
    `lock=${shellQuote(projectProvisionLockPath(project.id))}`,
    `repository=${shellQuote(root)}`,
    `git_dir=${shellQuote(projectGitDirectory(project.id))}`,
    `staging=${shellQuote(`${root}.provisioning`)}`,
    `expected_remote=${shellQuote(repositoryUrl)}`,
    repositorySizeVerdictSource(repositoryUrl),
    'mkdir -p "$projects"',
    ...reconcileClone({
      beforeClone: [
        // Only a named ceiling refuses. Any other output, even an unexpected one, lets the clone
        // proceed, so the check cannot fail closed on something it did not measure.
        `  size_verdict="$(${REPOSITORY_SIZE_VERDICT_FUNCTION})"`,
        '  case "$size_verdict" in',
        "    tree-truncated | too-many-files | working-tree-too-large | repository-too-large)",
        '      printf "repository exceeds a workspace size limit: %s\\n" "$size_verdict" >&2',
        `      exit ${PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE}`,
        "      ;;",
        "  esac",
      ],
      cloneIntoStaging: [
        `  if clone_output="$(${CLONE_INTO_STAGING} 2>&1)"; then`,
        "    :",
        "  else",
        "    clone_exit=$?",
        `    if printf '%s\\n' "$clone_output" | grep -Eiq 'no space left on device|disk quota exceeded|not enough space'; then`,
        '      printf "repository clone exceeded workspace capacity\\n" >&2',
        `      exit ${PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE}`,
        "    fi",
        '    printf "%s\\n" "$clone_output" >&2',
        '    exit "$clone_exit"',
        "  fi",
      ],
    }),
    'clone_size_kb="$(du -sk -- "$repository" | cut -f1)"',
    `printf "${PROJECT_CLONE_SIZE_MARKER}%s\\n" "$clone_size_kb"`,
  ].join("\n");
}

/**
 * Plan the whole of one project's provisioning. The plan is derived from the catalog project alone,
 * so two runs for one project produce the same steps and a resumed run asks for exactly what the
 * interrupted one did.
 *
 * Every path comes from `workspace-layout.ts`, which owns the whole layout. A project's clone is a
 * sibling of the harness checkout and of every other project rather than a container of its own
 * (ADR-0038), and the managed instructions sit above every clone for the reason that module
 * records: a managed file written inside a repository would either overwrite the repository's own
 * `AGENTS.md` or appear in the diff the user reviews.
 *
 * This module is shared by the workspace that provisions and the caller that asks for it, so both
 * plan a project the same way. It holds plain values only, and imports no platform API.
 */
export function planProjectProvision(project: Project): ProjectProvisionPlan {
  return {
    projectId: project.id,
    steps: [
      {
        name: "clone",
        source: cloneProjectRepository(project),
        // The clone moves the project root into place, so it cannot run inside it, and the
        // workspace root may not exist yet on a cold container.
        cwd: "/",
      },
      {
        name: "instructions",
        path: MANAGED_AGENT_INSTRUCTIONS_PATH,
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
