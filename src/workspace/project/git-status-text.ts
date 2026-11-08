import type { GitClient } from "@cloudflare/computer/git";
import type { StatusLine } from "./git-status.js";
import { branchTracking, type Tracking, trackingCounts, trackingLines } from "./git-tracking.js";

const LABELS = new Map([
  ["A", "new file:   "],
  ["M", "modified:   "],
  ["D", "deleted:    "],
]);

export interface HeadState {
  readonly branch: string | undefined;
  readonly oid: string | undefined;
  readonly tracking: Tracking | undefined;
}

export async function headState(client: GitClient, dir: string): Promise<HeadState> {
  const [branch, oid] = await Promise.all([
    client.currentBranch({ dir }),
    client.revParse({ dir, ref: "HEAD" }).catch((): undefined => {}),
  ]);

  const tracking =
    branch === undefined || oid === undefined
      ? undefined
      : await branchTracking(client, dir, branch);

  return { branch, oid, tracking };
}

function section(title: string, hints: readonly string[], lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [title, ...hints, ...lines.map((line) => `\t${line}`), ""];
}

function headLines(head: HeadState): string[] {
  if (head.branch === undefined) return [`HEAD detached at ${(head.oid ?? "").slice(0, 7)}`];

  if (head.oid === undefined) return [`On branch ${head.branch}`, "", "No commits yet", ""];

  if (head.tracking === undefined) return [`On branch ${head.branch}`];

  return [`On branch ${head.branch}`, ...trackingLines(head.tracking), ""];
}

function closingLine(
  staged: number,
  unstaged: number,
  untracked: number,
  unborn: boolean,
): string[] {
  if (staged > 0) return [];

  if (unstaged > 0) return ['no changes added to commit (use "git add" and/or "git commit -a")'];

  if (untracked > 0)
    return ['nothing added to commit but untracked files present (use "git add" to track)'];

  return [
    unborn
      ? 'nothing to commit (create/copy files and use "git add" to track)'
      : "nothing to commit, working tree clean",
  ];
}

export function longStatus(head: HeadState, lines: readonly StatusLine[]): string {
  const unborn = head.oid === undefined;

  const staged = lines.flatMap((line) =>
    line.x === " " || line.x === "?" ? [] : [`${LABELS.get(line.x) ?? ""}${line.path}`],
  );

  const unstagedLines = lines.filter((line) => line.y !== " " && line.y !== "?");
  const unstaged = unstagedLines.map((line) => `${LABELS.get(line.y) ?? ""}${line.path}`);
  const untracked = lines.flatMap((line) => (line.x === "?" ? [line.path] : []));
  const addHint = unstagedLines.some((line) => line.y === "D") ? "add/rm" : "add";

  const text = [
    ...headLines(head),
    ...section(
      "Changes to be committed:",
      [
        unborn
          ? '  (use "git rm --cached <file>..." to unstage)'
          : '  (use "git restore --staged <file>..." to unstage)',
      ],
      staged,
    ),
    ...section(
      "Changes not staged for commit:",
      [
        `  (use "git ${addHint} <file>..." to update what will be committed)`,
        '  (use "git restore <file>..." to discard changes in working directory)',
      ],
      unstaged,
    ),
    ...section(
      "Untracked files:",
      ['  (use "git add <file>..." to include in what will be committed)'],
      untracked,
    ),
    ...closingLine(staged.length, unstaged.length, untracked.length, unborn),
  ];

  return `${text.join("\n")}\n`;
}

export function branchHeader(head: HeadState): string {
  if (head.branch === undefined) return "## HEAD (no branch)\n";

  if (head.oid === undefined) return `## No commits yet on ${head.branch}\n`;

  if (head.tracking === undefined) return `## ${head.branch}\n`;

  const counts = trackingCounts(head.tracking);

  return `## ${head.branch}...${head.tracking.upstream}${counts === "" ? "" : ` [${counts}]`}\n`;
}
