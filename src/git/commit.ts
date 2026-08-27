import { isSha, parseSha } from "./types.js";
import type { Commit, GitObject, Sha, Signature } from "./types.js";
import { concat, concatMany, decodeUtf8, encodeUtf8 } from "./binary.js";

export function encodeCommit(commit: Commit): Uint8Array {
  const parts: Uint8Array[] = [
    encodeUtf8(`tree ${validateSha(commit.tree, "commit tree")}\n`, "commit header"),
  ];
  for (const parent of commit.parents) {
    parts.push(encodeUtf8(`parent ${validateSha(parent, "commit parent")}\n`, "commit header"));
  }
  parts.push(
    encodeUtf8(`author ${formatSignature(commit.author)}\n`, "commit header"),
    encodeUtf8(`committer ${formatSignature(commit.committer)}\n`, "commit header"),
    encodeUtf8("\n", "commit separator"),
    encodeUtf8(commit.message, "commit message"),
  );

  const body = concatMany(parts);
  return concat(encodeUtf8(`commit ${body.byteLength}\0`, "object header"), body);
}

export function decodeCommit(body: Uint8Array): Extract<GitObject, { type: "commit" }> {
  const text = decodeUtf8(body, "commit");
  const separator = text.indexOf("\n\n");
  if (separator < 0) {
    throw new Error("malformed git commit: missing header separator");
  }

  const headers = text.slice(0, separator).split("\n");
  let index = 0;
  const treeLine = requireCommitLine(headers, index, "tree");
  index += 1;
  const tree = parseShaLine(treeLine, "tree");
  const parents: Sha[] = [];
  while (headers[index]?.startsWith("parent ") === true) {
    const parentLine = requireCommitLine(headers, index, "parent");
    parents.push(parseShaLine(parentLine, "parent"));
    index += 1;
  }

  const authorLine = requireCommitLine(headers, index, "author");
  index += 1;
  const committerLine = requireCommitLine(headers, index, "committer");
  index += 1;
  if (index !== headers.length) {
    throw new Error("malformed git commit: unexpected header");
  }

  return {
    type: "commit",
    commit: {
      tree,
      parents,
      author: parseSignature(authorLine, "author"),
      committer: parseSignature(committerLine, "committer"),
      message: text.slice(separator + 2),
    },
  };
}

function requireCommitLine(headers: readonly string[], index: number, label: string): string {
  const line = headers[index];
  if (line === undefined) {
    throw new Error(`malformed git commit: missing ${label} header`);
  }
  return line;
}

function parseShaLine(line: string, label: string): Sha {
  const prefix = `${label} `;
  if (!line.startsWith(prefix)) {
    throw new Error(`malformed git commit: expected ${label} header`);
  }
  try {
    return parseSha(line.slice(prefix.length));
  } catch (error: unknown) {
    throw new Error(`malformed git commit: invalid ${label} sha`, {
      cause: error,
    });
  }
}

function parseSignature(line: string, label: string): Signature {
  const prefix = `${label} `;
  if (!line.startsWith(prefix)) {
    throw new Error(`malformed git commit: expected ${label} header`);
  }
  const match = /^(.+) <([^<>]+)> (-?[0-9]+) ([+-][0-9]{4})$/u.exec(line.slice(prefix.length));
  if (match === null) {
    throw new Error(`malformed git commit: invalid ${label} signature`);
  }
  const name = match[1];
  const email = match[2];
  const timestampText = match[3];
  const timezoneText = match[4];
  if (
    name === undefined ||
    email === undefined ||
    timestampText === undefined ||
    timezoneText === undefined
  ) {
    throw new Error(`malformed git commit: incomplete ${label} signature`);
  }
  validateIdentityPart(name, "name");
  validateIdentityPart(email, "email");

  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || String(timestamp) !== timestampText) {
    throw new Error(`malformed git commit: invalid ${label} timestamp`);
  }
  const timezoneOffsetMinutes = parseTimezone(timezoneText, label);
  return { name, email, timestamp, timezoneOffsetMinutes };
}

function parseTimezone(value: string, label: string): number {
  const sign = value[0];
  const hoursText = value.slice(1, 3);
  const minutesText = value.slice(3, 5);
  if (sign === undefined || (sign !== "+" && sign !== "-")) {
    throw new Error(`malformed git commit: invalid ${label} timezone`);
  }
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const absoluteMinutes = hours * 60 + minutes;
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    throw new Error(`malformed git commit: invalid ${label} timezone`);
  }
  const offset = sign === "-" ? -absoluteMinutes : absoluteMinutes;
  if (formatTimezone(offset) !== value) {
    throw new Error(`malformed git commit: non-canonical ${label} timezone`);
  }
  return offset;
}

function formatSignature(signature: Signature): string {
  validateIdentityPart(signature.name, "name");
  validateIdentityPart(signature.email, "email");
  if (!Number.isSafeInteger(signature.timestamp)) {
    throw new TypeError("git signature timestamp must be a safe integer");
  }
  return `${signature.name} <${signature.email}> ${signature.timestamp} ${formatTimezone(signature.timezoneOffsetMinutes)}`;
}

function validateIdentityPart(value: string, label: string): void {
  if (value.length === 0 || /[\r\n<>]/u.test(value)) {
    throw new TypeError(`git signature ${label} is invalid`);
  }
}

function formatTimezone(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < -1439 || offset > 1439) {
    throw new TypeError("git signature timezone offset is out of range");
  }
  const absolute = Math.abs(offset);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  const sign = offset < 0 ? "-" : "+";
  return `${sign}${hours.toString().padStart(2, "0")}${minutes.toString().padStart(2, "0")}`;
}

function validateSha(value: Sha, label: string): Sha {
  if (!isSha(value)) {
    throw new TypeError(`invalid ${label} sha ${JSON.stringify(value)}`);
  }
  return value;
}
