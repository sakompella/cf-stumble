import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Helpers for Node tests that run planned workspace shell under `/bin/sh` on the host. The plans
 * name fixed `/workspace/...` paths, so a test moves them under a scratch directory first.
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

/** Point every quoted `/workspace/` path in planned shell at `root/workspace/`. */
export function underScratch(source: string, root: string): string {
  return source.replaceAll("'/workspace/", `'${root}/workspace/`);
}

export function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** A new scratch directory under the host's temporary directory. */
export function scratchDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
