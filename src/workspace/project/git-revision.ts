import type { GitClient } from "@cloudflare/computer/git";

export const AMBIGUOUS = (target: string): string =>
  `fatal: ambiguous argument '${target}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n`;

export async function resolves(
  client: GitClient,
  dir: string,
  ref: string,
): Promise<string | undefined> {
  try {
    return await client.revParse({ dir, ref });
  } catch {
    return undefined;
  }
}
