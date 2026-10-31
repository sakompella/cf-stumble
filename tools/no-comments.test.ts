import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((path) => path !== "" && !/^(?:vendor|docs|tools\/oxlint\/anti-slop)\//u.test(path));

const DIRECTIVE = /\b(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck)/u;

const SHELL_WORD_BREAK = /[\s;&|()]/u;

function lineNumber(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function shellCommentLines(text: string): number[] {
  const lines: number[] = [];
  let quote: "'" | '"' | undefined;
  let index = text.startsWith("#!") ? text.indexOf("\n") : 0;

  while (index !== -1 && index < text.length) {
    const character = text.charAt(index);

    if (
      quote === undefined &&
      character === "#" &&
      SHELL_WORD_BREAK.test(text.charAt(index - 1) || "\n")
    ) {
      lines.push(lineNumber(text, index));
      index = text.indexOf("\n", index);
    } else {
      if (character === "\\" && quote !== "'") index += 1;
      else if (quote === undefined && (character === "'" || character === '"')) quote = character;
      else if (character === quote) quote = undefined;
      index += 1;
    }
  }

  return lines;
}

function jsonCommentLines(text: string): number[] {
  const lines: number[] = [];
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);

    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "/" && "/*".includes(text.charAt(index + 1))) {
      lines.push(lineNumber(text, index));
    }
  }

  return lines;
}

function dockerfileCommentLines(text: string): number[] {
  return text.split("\n").flatMap((line, index) => (/^\s*#/u.test(line) ? [index + 1] : []));
}

function directiveLines(text: string): number[] {
  return text.split("\n").flatMap((line, index) => (DIRECTIVE.test(line) ? [index + 1] : []));
}

function findings(pattern: RegExp, scan: (text: string) => number[]): string[] {
  return tracked
    .filter((path) => pattern.test(path))
    .flatMap((path) => scan(readFileSync(path, "utf8")).map((line) => `${path}:${line}`));
}

describe("first-party files carry no comments", () => {
  it("has no lint or TypeScript directive that could silence cf-stumble/no-comments", () => {
    assert.deepEqual(findings(/\.[cm]?[jt]s$/u, directiveLines), []);
  });

  it("has no comment in a shell script", () => {
    assert.deepEqual(findings(/\.sh$|^\.githooks\//u, shellCommentLines), []);
  });

  it("has no comment in a Dockerfile", () => {
    assert.deepEqual(findings(/Dockerfile$/u, dockerfileCommentLines), []);
  });

  it("has no comment in a JSON configuration file", () => {
    assert.deepEqual(findings(/\.jsonc?$/u, jsonCommentLines), []);
  });
});
