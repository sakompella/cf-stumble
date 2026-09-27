import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Helpers for Node tests that run planned workspace shell under `/bin/sh` on the host. The plans
 * name fixed `/workspace/...` and `/tmp/...` paths, so a test moves them under a scratch directory
 * first.
 */

/** A `git` stand-in for the clone step: no existing clone, and `clone` creates the target. */
export const STUB_GIT = `#!/bin/sh
case "$*" in
  *rev-parse*)
    if [ -e "$STUB_DIR/existing-clone" ]; then printf 'false\\n'; exit 0; fi
    exit 128
    ;;
  clone\\ *)
    for target; do :; done
    mkdir -p "$target/.git"
    printf 'clone\\n' >> "$STUB_DIR/git.log"
    ;;
  *--get-all\\ remote.origin.url*) printf '%s\\n' "$STUB_REMOTE" ;;
esac
exit 0
`;

/**
 * Point every quoted `/workspace/` and `/tmp/` path in planned shell under `root`. The caller
 * creates `root/tmp` first.
 */
export function underScratch(source: string, root: string): string {
  return source
    .replaceAll("'/workspace/", `'${root}/workspace/`)
    .replaceAll("'/tmp/", `'${root}/tmp/`);
}

/**
 * A `flock <descriptor>` stand-in. It takes the kernel lock on the inherited descriptor with
 * util-linux `flock` where the host has it, and with Perl's `flock` otherwise (macOS has none).
 * The lock belongs to the open file, so it stays held after the stand-in exits.
 */
export const FLOCK_STAND_IN = `#!/bin/sh
for real in /usr/bin/flock /bin/flock; do
  if [ -x "$real" ]; then exec "$real" "$@"; fi
done
exec perl -MFcntl=:flock -e 'open(my $held, ">&=", $ARGV[0]) or die "flock stand-in: $!\n"; flock($held, LOCK_EX) or die "flock stand-in: $!\n";' -- "$1"
`;

export function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** A new scratch directory under the host's temporary directory. */
export function scratchDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
