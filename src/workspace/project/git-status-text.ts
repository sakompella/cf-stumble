import type { GitClient, StatusEntry } from "@cloudflare/computer/git";

const LABELS = {
  A: "new file:   ",
  M: "modified:   ",
  D: "deleted:    ",
} as const;

function section(title: string, hint: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [title, hint, ...lines.map((line) => `\t${line}`), ""];
}

function longStatus(branch: string | undefined, entries: readonly StatusEntry[]): string {
  const staged = entries.flatMap((entry) =>
    entry.index === " " ? [] : [`${LABELS[entry.index]}${entry.path}`],
  );

  const unstaged = entries.flatMap((entry) =>
    entry.worktree === " " || entry.worktree === "?"
      ? []
      : [`${LABELS[entry.worktree]}${entry.path}`],
  );

  const untracked = entries.flatMap((entry) => (entry.worktree === "?" ? [entry.path] : []));

  const lines = [
    branch === undefined ? "HEAD detached" : `On branch ${branch}`,
    ...section(
      "Changes to be committed:",
      '  (use "git restore --staged <file>..." to unstage)',
      staged,
    ),
    ...section(
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      unstaged,
    ),
    ...section(
      "Untracked files:",
      '  (use "git add <file>..." to include in what will be committed)',
      untracked,
    ),
  ];

  if (entries.length === 0) lines.push("nothing to commit, working tree clean");
  else if (staged.length === 0) lines.push('no changes added to commit (use "git add")');

  return `${lines.join("\n")}\n`;
}

export async function gitStatusText(client: GitClient, dir: string): Promise<string> {
  const [branch, entries] = await Promise.all([
    client.currentBranch({ dir }),
    client.status({ dir }),
  ]);

  return longStatus(branch, entries);
}
