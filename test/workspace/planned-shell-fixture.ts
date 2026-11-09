import { devShellTool } from "../dev-shell-tool.js";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
  return source.replaceAll(
    /'\/(workspace|tmp)(?=['/])/gu,
    (quoted, directory: string, offset: number) =>
      source.startsWith(root, offset + 1) ? quoted : `'${root}/${directory}`,
  );
}

export const FLOCK_STAND_IN = `#!/bin/sh
[ -z "$STUB_FLOCK_MARK" ] || : > "$STUB_FLOCK_MARK"
exec perl -MFcntl=:flock -e 'open(my $held, ">&=", $ARGV[0]) or die "flock stand-in: $!\n"; flock($held, LOCK_EX) or die "flock stand-in: $!\n";' -- "$1"
`;

export function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

export function scratchDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const SYSTEM_TOOLS = ["cat", "ls", "mkdir", "mv", "perl", "rm", "rmdir", "sleep", "tr"] as const;

export function systemToolsDirectory(parent: string): string {
  const directory = join(parent, "system-bin");
  mkdirSync(directory);

  for (const tool of SYSTEM_TOOLS) {
    symlinkSync(devShellTool(tool), join(directory, tool));
  }

  return directory;
}
