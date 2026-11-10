import type { GitClient } from "@cloudflare/computer/git";

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
