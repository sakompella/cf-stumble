import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitCliResult } from "@cloudflare/computer/git";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

const IDENTITY = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@e",
};

const ENVIRONMENT = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  ...IDENTITY,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

export const FLAG_SETS: readonly (readonly string[])[] = [
  [],
  ["-s"],
  ["--porcelain"],
  ["-sb"],
  ["-b"],
  ["--short", "--branch"],
  ["-s", "--porcelain"],
  ["--porcelain", "-s"],
  ["--porcelain", "--long"],
  ["--porcelain", "-b"],
];

export const PATHS = ["", "d/", "d/e/", "f/"].flatMap((directory) =>
  ["a", "b", "c"].map((name) => `${directory}${name}`),
);

export type Run = (dir: string, args: readonly string[]) => Promise<GitCliResult>;

export function realGit(dir: string, args: readonly string[]): GitCliResult {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENVIRONMENT });

  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
}

export const real: Run = (dir, args) => Promise.resolve(realGit(dir, args));

export function realStatus(dir: string, prefix: string, flags: readonly string[]): string {
  return realGit(join(dir, prefix), ["status", ...flags]).stdout;
}

export function scratch(): string {
  return mkdtempSync(join(tmpdir(), "git-status-"));
}

export function remove(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

let clock = Math.floor(Date.now() / 1000) - 100_000;

export function put(dir: string, path: string, content: string): void {
  directoryFor(dir, path);
  writeFileSync(join(dir, path), content);
  clock += 1;
  utimesSync(join(dir, path), clock, clock);
}

function walk(dir: string, from: string): string[] {
  return readdirSync(join(dir, from), { withFileTypes: true }).flatMap((entry) => {
    const path = from === "" ? entry.name : `${from}/${entry.name}`;

    if (entry.name === ".git") return [];

    return entry.isDirectory() ? walk(dir, path) : [path];
  });
}

export function files(dir: string): string[] {
  return walk(dir, "").toSorted();
}

export function directories(dir: string): string[] {
  const parents = files(dir).flatMap((path) => {
    const parts = path.split("/").slice(0, -1);

    return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  });

  return ["", ...new Set(parents)].filter((path) => existsSync(join(dir, path))).toSorted();
}

export function directoryFor(dir: string, path: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
}

export interface Base {
  readonly tag: string;
  readonly lines: number;
  readonly long: boolean;
}

export function drawBases(tc: TestCase): Base[] {
  const count = tc.draw(gs.integers({ minValue: 2, maxValue: 3 }));

  return Array.from({ length: count }, (_, index) => ({
    tag: String.fromCodePoint(97 + index),
    lines: tc.draw(gs.integers({ minValue: 1, maxValue: 6 })),
    long: tc.draw(gs.booleans()),
  }));
}

export function drawContent(tc: TestCase, bases: readonly Base[]): string {
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 7 })) === 0) return "";

  const base = tc.draw(gs.sampledFrom(bases));
  const replaced = tc.draw(gs.integers({ minValue: 0, maxValue: base.lines }));
  const extra = tc.draw(gs.integers({ minValue: 0, maxValue: 1 }));
  const style = tc.draw(gs.sampledFrom(["plain", "plain", "plain", "crlf", "binary"]));

  const text = Array.from({ length: base.lines + extra }, (_, index) => {
    const tag = index < replaced ? "z" : base.tag;

    return base.long ? `${tag}${index} some line of text\n` : `${tag}${index}\n`;
  }).join("");

  if (style === "crlf") return text.replaceAll("\n", "\r\n");

  return style === "binary" ? `\0${text}` : text;
}
