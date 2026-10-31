import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export function underScratch(source: string, root: string): string {
  return source
    .replaceAll("'/workspace/", `'${root}/workspace/`)
    .replaceAll("'/tmp/", `'${root}/tmp/`);
}

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

export function scratchDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
