const PROJECT_CLONE_DEPTH = 50;

export function holdProvisionLock(): readonly string[] {
  return ['exec 9>"$lock"', "flock 9"];
}

export const CLONE_INTO_STAGING = `git clone --filter=blob:none --depth=${PROJECT_CLONE_DEPTH} --single-branch "$expected_remote" "$staging"`;

export function reconcileClone(
  steps: Readonly<{ beforeClone: readonly string[]; cloneIntoStaging: readonly string[] }>,
): readonly string[] {
  const { beforeClone, cloneIntoStaging } = steps;

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
