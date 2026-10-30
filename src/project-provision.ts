import { invariant } from "./invariant.js";
import { shellQuote } from "./shell-quote.js";
import { PROJECTS_DIRECTORY, projectDirectory, projectGitDirectory } from "./workspace-layout.js";
import type { Project, ProjectId } from "./project-catalog.js";
import {
  durableGitHubConfigurationSource,
  REPOSITORY_SIZE_VERDICT_FUNCTION,
  repositorySizeVerdictSource,
} from "./github/index.js";

/**
 * Blob filtering keeps the durable clone small; Git fetches a blob only when a command needs it.
 */
const PROJECT_CLONE_DEPTH = 50;

export const PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE = 122;

export const MANAGED_AGENT_INSTRUCTIONS = [
  "# cf-stumble managed instructions",
  "",
  "cf-stumble rewrites this file before every turn.",
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

/**
 * The managed instructions are not a step: both plans write that file through the Host's
 * `ensureManagedInstructions`.
 */
export type ProjectProvisionStepName = "clone";

type ProjectProvisionStep = Readonly<{ name: "clone"; source: string; cwd: string }>;

type ProjectProvisionPlan = Readonly<{
  projectId: ProjectId;
  steps: readonly [ProjectProvisionStep, ...ProjectProvisionStep[]];
}>;

export const PROJECT_PROVISION_STEP_NAMES: readonly ProjectProvisionStepName[] = ["clone"];

export function projectProvisionLockPath(projectId: ProjectId): string {
  return `/tmp/cf-stumble-project-${projectId}.provision.lock`;
}

/**
 * Nothing records a pid, so there is no stale owner: the kernel releases the flock when the last
 * process holding the descriptor exits. The file stays out of `/workspace`, which Computer copies
 * to
 * and from its store, and is never deleted: a waiter locking a deleted file would not exclude a
 * newcomer creating a fresh one.
 * Descriptor 9 stays open in every child because the computerd runner signals only the direct
 * shell, so a `git clone` that outlives a killed shell keeps the lock until it exits.
 */
export function holdProvisionLock(): readonly string[] {
  return ['exec 9>"$lock"', "flock 9"];
}

const CLONE_INTO_STAGING = `git clone --filter=blob:none --depth=${PROJECT_CLONE_DEPTH} --single-branch "$expected_remote" "$staging"`;

/**
 * Reconciling means a clone of the expected remote is here, never that the tree matches origin:
 * uncommitted work and unpushed commits live there, so an existing clone is only checked.
 * Nothing deletes a directory it did not create; a populated non-repository fails the step
 * untouched.
 * The clone lands in a fixed staging directory and moves into place only on success, and the `EXIT`
 * trap is set once the lock is held, so the next run clears what a killed run left. `rmdir` removes
 * the root only when empty.
 * `cloneIntoStaging` replaces the plain clone, for a caller that maps a clone failure to its own
 * exit code.
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
    'if test "$actual_remote" != "$expected_remote"; then',
    '  printf "%s has a different origin than %s\\n" "$repository" "$expected_remote" >&2',
    "  exit 1",
    "fi",
  ];
}

/**
 * The repository is measured with the workspace's own `gh` credential before a new clone, which
 * covers private repositories the Supervisor's `GH_TOKEN` preflight cannot see. An unmeasurable
 * repository is cloned anyway; an existing clone is never measured or removed.
 * Every shell value goes through `shellQuote`: the repository URL is configuration, and
 * hand-written escaping is how a quoting helper becomes an injection.
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
        // Only a named ceiling refuses; any other output lets the clone proceed, so the check
        // cannot fail closed on something it did not measure.
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
  ].join("\n");
}

/**
 * The plan derives from the project alone, so a resumed run asks for exactly what the interrupted
 * one did.
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
    ],
  };
}

export function projectProvisionStep(
  plan: ProjectProvisionPlan,
  name: ProjectProvisionStepName,
): ProjectProvisionStep {
  const step = plan.steps.find((planned) => planned.name === name);
  invariant(step !== undefined, `the provisioning plan must contain its own ${name} step`);

  return step;
}
