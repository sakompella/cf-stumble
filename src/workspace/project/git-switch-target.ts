import type { GitCliResult, GitClient } from "@cloudflare/computer/git";
import { failure } from "./git-result.js";
import { resolves } from "./git-revision.js";

const HEADS = /^(?:refs\/)?heads\/(.+)$/u;

function expected(what: string): GitCliResult {
  return failure(
    `fatal: a branch is expected, got ${what}\nhint: If you want to detach HEAD at the commit, try again with the --detach option.\n`,
  );
}

async function exists(client: GitClient, dir: string, ref: string): Promise<boolean> {
  return (await resolves(client, dir, ref)) !== undefined;
}

async function remoteBranch(client: GitClient, dir: string, name: string): Promise<boolean> {
  const remotes = await client.remoteList({ dir });

  const found = await Promise.all(
    remotes.map(({ name: remote }) => exists(client, dir, `refs/remotes/${remote}/${name}`)),
  );

  return found.includes(true);
}

export async function nonBranchTarget(
  client: GitClient,
  dir: string,
  name: string,
): Promise<GitCliResult | undefined> {
  const branches = await client.branchList({ dir });

  if (branches.includes(name)) return undefined;

  const qualified = HEADS.exec(name)?.[1];

  if (qualified !== undefined && branches.includes(qualified))
    return expected(`'refs/heads/${qualified}'`);

  if (name === "HEAD") {
    const current = await client.currentBranch({ dir });

    return expected(current === undefined ? "'HEAD'" : `'refs/heads/${current}'`);
  }

  if (await exists(client, dir, `refs/tags/${name}`)) return expected(`tag '${name}'`);

  if (await exists(client, dir, `refs/remotes/${name}`)) return expected(`remote branch '${name}'`);

  if (await exists(client, dir, name)) return expected(`commit '${name}'`);

  return (await remoteBranch(client, dir, name))
    ? undefined
    : failure(`fatal: invalid reference: ${name}\n`);
}
