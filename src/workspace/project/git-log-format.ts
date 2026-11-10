import type { CommitView } from "@cloudflare/computer/git";

export interface LogFormat {
  readonly kind: "full" | "oneline" | "custom";
  readonly spec: string;
  readonly separated: boolean;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const PLACEHOLDER = /%(a[nde]|c[nde]|[HhTtPpsb%n])/gu;

const ABBREVIATION = 7;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function gitDate(person: CommitView["author"]): string {
  const east = -person.timezoneOffset;
  const local = new Date((person.timestamp + east * 60) * 1000);
  const sign = east < 0 ? "-" : "+";
  const minutes = Math.abs(east);

  return `${WEEKDAYS[local.getUTCDay()]} ${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ${local.getUTCFullYear()} ${sign}${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}`;
}

function messageLines(commit: CommitView): string[] {
  return commit.message.replace(/\n+$/u, "").split("\n");
}

function subject(commit: CommitView): string {
  const lines = messageLines(commit);
  const end = lines.indexOf("");

  return (end === -1 ? lines : lines.slice(0, end)).join(" ");
}

function body(commit: CommitView): string {
  const lines = messageLines(commit);
  const end = lines.indexOf("");
  const rest = end === -1 ? "" : lines.slice(end + 1).join("\n");

  return rest === "" ? "" : `${rest}\n`;
}

function expand(commit: CommitView, code: string): string {
  switch (code) {
    case "H":
      return commit.oid;
    case "h":
      return commit.oid.slice(0, ABBREVIATION);
    case "T":
      return commit.tree;
    case "t":
      return commit.tree.slice(0, ABBREVIATION);
    case "P":
      return commit.parent.join(" ");
    case "p":
      return commit.parent.map((oid) => oid.slice(0, ABBREVIATION)).join(" ");
    case "s":
      return subject(commit);
    case "b":
      return body(commit);
    case "an":
      return commit.author.name;
    case "ae":
      return commit.author.email;
    case "ad":
      return gitDate(commit.author);
    case "cn":
      return commit.committer.name;
    case "ce":
      return commit.committer.email;
    case "cd":
      return gitDate(commit.committer);
    case "n":
      return "\n";
    default:
      return "%";
  }
}

export function supportedSpec(spec: string): boolean {
  return !spec.replaceAll(PLACEHOLDER, "").includes("%");
}

function full(commit: CommitView): string {
  const lines = messageLines(commit).map((line) => `    ${line}`);

  const merge =
    commit.parent.length > 1
      ? [`Merge: ${commit.parent.map((oid) => oid.slice(0, ABBREVIATION)).join(" ")}`]
      : [];

  return [
    `commit ${commit.oid}`,
    ...merge,
    `Author: ${commit.author.name} <${commit.author.email}>`,
    `Date:   ${gitDate(commit.author)}`,
    "",
    ...lines,
    "",
  ].join("\n");
}

function one(commit: CommitView, format: LogFormat): string {
  if (format.kind === "full") return full(commit);

  if (format.kind === "oneline") return `${commit.oid.slice(0, ABBREVIATION)} ${subject(commit)}`;

  return format.spec.replaceAll(PLACEHOLDER, (_match, code: string) => expand(commit, code));
}

export function renderLog(commits: readonly CommitView[], format: LogFormat): string {
  if (commits.length === 0) return "";

  const parts = commits.map((commit) => one(commit, format));

  if (format.kind === "full") return parts.join("\n");

  return format.separated ? parts.join("\n") : parts.map((part) => `${part}\n`).join("");
}
