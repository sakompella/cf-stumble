import type { CommitView } from "@cloudflare/computer/git";

export function gitOrder(commits: readonly CommitView[], head: string): readonly CommitView[] {
  const known = new Map(commits.map((commit) => [commit.oid, commit]));
  const queue: CommitView[] = [];
  const seen = new Set<string>([head]);
  const ordered: CommitView[] = [];

  const start = known.get(head);

  if (start !== undefined) queue.push(start);

  while (queue.length > 0) {
    const [next] = queue.splice(0, 1);

    if (next === undefined) break;

    ordered.push(next);

    for (const oid of next.parent) {
      const parent = known.get(oid);

      if (parent === undefined || seen.has(oid)) continue;

      seen.add(oid);

      const after = queue.findIndex(
        (queued) => queued.committer.timestamp < parent.committer.timestamp,
      );

      queue.splice(after === -1 ? queue.length : after, 0, parent);
    }
  }

  return ordered;
}
