import type { GitClient } from "@cloudflare/computer/git";

export interface Tracking {
  readonly upstream: string;
  readonly ahead: number;
  readonly behind: number;
}

interface TrackingClient {
  configGet: GitClient["configGet"];
  revParse: GitClient["revParse"];
  log: GitClient["log"];
}

async function configString(
  client: TrackingClient,
  dir: string,
  key: string,
): Promise<string | undefined> {
  const value = await client.configGet({ dir, path: key });

  return Array.isArray(value) ? value[0] : value;
}

async function oids(
  client: TrackingClient,
  dir: string,
  ref: string,
  depth: number,
): Promise<string[]> {
  const commits = await client.log({ dir, ref, depth });

  return commits.map((commit) => commit.oid);
}

async function aheadBehind(
  client: TrackingClient,
  dir: string,
  local: string,
  upstream: string,
): Promise<[number, number]> {
  for (let depth = 64; ; depth *= 4) {
    const [mine, theirs] = await Promise.all([
      oids(client, dir, local, depth),
      oids(client, dir, upstream, depth),
    ]);

    const mineSet = new Set(mine);
    const theirSet = new Set(theirs);
    const complete = mine.length < depth && theirs.length < depth;

    if (complete) {
      return [
        mine.filter((oid) => !theirSet.has(oid)).length,
        theirs.filter((oid) => !mineSet.has(oid)).length,
      ];
    }
  }
}

export async function branchTracking(
  client: TrackingClient,
  dir: string,
  branch: string,
): Promise<Tracking | undefined> {
  const [remote, merge] = await Promise.all([
    configString(client, dir, `branch.${branch}.remote`),
    configString(client, dir, `branch.${branch}.merge`),
  ]);

  if (remote === undefined || merge === undefined) return undefined;

  const upstream = `${remote}/${merge.replace(/^refs\/heads\//u, "")}`;

  const [local, remoteOid] = await Promise.all([
    client.revParse({ dir, ref: `refs/heads/${branch}` }),
    client.revParse({ dir, ref: `refs/remotes/${upstream}` }).catch((): undefined => {}),
  ]);

  if (remoteOid === undefined) return undefined;

  if (local === remoteOid) return { upstream, ahead: 0, behind: 0 };

  const [ahead, behind] = await aheadBehind(client, dir, local, remoteOid);

  return { upstream, ahead, behind };
}

function commitCount(count: number): string {
  return count === 1 ? "1 commit" : `${String(count)} commits`;
}

export function trackingLines(tracking: Tracking): string[] {
  const { upstream, ahead, behind } = tracking;

  if (ahead > 0 && behind > 0)
    return [
      `Your branch and '${upstream}' have diverged,`,
      `and have ${String(ahead)} and ${String(behind)} different commits each, respectively.`,
      '  (use "git pull" if you want to integrate the remote branch with yours)',
    ];

  if (ahead > 0)
    return [
      `Your branch is ahead of '${upstream}' by ${commitCount(ahead)}.`,
      '  (use "git push" to publish your local commits)',
    ];

  if (behind > 0)
    return [
      `Your branch is behind '${upstream}' by ${commitCount(behind)}, and can be fast-forwarded.`,
      '  (use "git pull" to update your local branch)',
    ];

  return [`Your branch is up to date with '${upstream}'.`];
}

export function trackingCounts(tracking: Tracking): string {
  const parts = [
    ...(tracking.ahead > 0 ? [`ahead ${String(tracking.ahead)}`] : []),
    ...(tracking.behind > 0 ? [`behind ${String(tracking.behind)}`] : []),
  ];

  return parts.join(", ");
}
