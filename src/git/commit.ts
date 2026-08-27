import { Result, panic } from "better-result";
import { isSha, parseShaResult } from "./types.js";
import type { Commit, GitObject, Sha, Signature } from "./types.js";
import { GitObjectDecodeError } from "./errors.js";
import type { GitObjectDecodeCondition } from "./errors.js";
import { concat, concatMany, decodeUtf8, encodeUtf8 } from "./binary.js";

type DecodedCommit = Extract<GitObject, { type: "commit" }>;

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

export function decodeCommit(body: Uint8Array): Result<DecodedCommit, GitObjectDecodeError> {
  return Result.gen(function* () {
    const text = yield* decodeUtf8(body, "commit", "commit body");
    const separator = text.indexOf("\n\n");
    if (separator < 0) {
      return Result.err(commitError("missing-separator", "missing header separator"));
    }

    const headers = text.slice(0, separator).split("\n");
    let index = 0;
    const tree = yield* parseShaLine(yield* requireCommitLine(headers, index, "tree"), "tree");
    index += 1;

    const parents: Sha[] = [];
    while (headers[index]?.startsWith("parent ") === true) {
      const line = yield* requireCommitLine(headers, index, "parent");
      parents.push(yield* parseShaLine(line, "parent"));
      index += 1;
    }

    const authorLine = yield* requireCommitLine(headers, index, "author");
    index += 1;
    const committerLine = yield* requireCommitLine(headers, index, "committer");
    index += 1;
    if (index !== headers.length) {
      return Result.err(commitError("unexpected-header", "unexpected header"));
    }

    const author = yield* parseSignature(authorLine, "author");
    const committer = yield* parseSignature(committerLine, "committer");
    const decoded = {
      type: "commit",
      commit: { tree, parents, author, committer, message: text.slice(separator + 2) },
    } satisfies DecodedCommit;
    return Result.ok<DecodedCommit>(decoded);
  });
}

function commitError(condition: GitObjectDecodeCondition, detail: string): GitObjectDecodeError {
  return new GitObjectDecodeError({ layer: "commit", condition, detail });
}

function requireCommitLine(
  headers: readonly string[],
  index: number,
  label: string,
): Result<string, GitObjectDecodeError> {
  const line = headers[index];
  if (line === undefined) {
    return Result.err(commitError("missing-header", `missing ${label} header`));
  }
  return Result.ok(line);
}

function parseShaLine(line: string, label: string): Result<Sha, GitObjectDecodeError> {
  const prefix = `${label} `;
  if (!line.startsWith(prefix)) {
    return Result.err(commitError("expected-header", `expected ${label} header`));
  }
  const sha = parseShaResult(line.slice(prefix.length));
  if (Result.isError(sha)) {
    return Result.err(
      new GitObjectDecodeError({
        layer: "commit",
        condition: "invalid-sha",
        detail: `invalid ${label} sha`,
        cause: sha.error,
      }),
    );
  }
  return sha;
}

const SIGNATURE = /^(.+) <([^<>]+)> (-?[0-9]+) ([+-][0-9]{4})$/u;

function parseSignature(line: string, label: string): Result<Signature, GitObjectDecodeError> {
  const prefix = `${label} `;
  if (!line.startsWith(prefix)) {
    return Result.err(commitError("expected-header", `expected ${label} header`));
  }
  const match = SIGNATURE.exec(line.slice(prefix.length));
  if (match === null) {
    return Result.err(commitError("invalid-signature", `invalid ${label} signature`));
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
    // All four groups are unconditional in SIGNATURE, so a match always captures them.
    panic(`git ${label} signature matched ${String(SIGNATURE)} without capturing all four groups`);
  }
  // `.` and `[^<>]` both admit a carriage return, which the encoder refuses to write, so a
  // signature can be well-shaped and still hold a character that would not round-trip.
  if (!isValidIdentityPart(name) || !isValidIdentityPart(email)) {
    return Result.err(commitError("invalid-identity", `invalid ${label} name or email`));
  }

  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || String(timestamp) !== timestampText) {
    return Result.err(commitError("invalid-timestamp", `invalid ${label} timestamp`));
  }
  const timezoneOffsetMinutes = parseTimezone(timezoneText, label);
  if (Result.isError(timezoneOffsetMinutes)) {
    return timezoneOffsetMinutes;
  }
  return Result.ok({ name, email, timestamp, timezoneOffsetMinutes: timezoneOffsetMinutes.value });
}

function parseTimezone(value: string, label: string): Result<number, GitObjectDecodeError> {
  const sign = value[0];
  const hoursText = value.slice(1, 3);
  const minutesText = value.slice(3, 5);
  if (sign === undefined || (sign !== "+" && sign !== "-")) {
    return Result.err(commitError("invalid-timezone", `invalid ${label} timezone`));
  }
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const absoluteMinutes = hours * 60 + minutes;
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return Result.err(commitError("invalid-timezone", `invalid ${label} timezone`));
  }
  const offset = sign === "-" ? -absoluteMinutes : absoluteMinutes;
  if (formatTimezone(offset) !== value) {
    return Result.err(commitError("non-canonical-timezone", `non-canonical ${label} timezone`));
  }
  return Result.ok(offset);
}

function formatSignature(signature: Signature): string {
  validateIdentityPart(signature.name, "name");
  validateIdentityPart(signature.email, "email");
  if (!Number.isSafeInteger(signature.timestamp)) {
    throw new TypeError("git signature timestamp must be a safe integer");
  }
  return `${signature.name} <${signature.email}> ${signature.timestamp} ${formatTimezone(signature.timezoneOffsetMinutes)}`;
}

/** The shared rule: an identity part must be non-empty and free of the delimiters git writes. */
function isValidIdentityPart(value: string): boolean {
  return value.length > 0 && !/[\r\n<>]/u.test(value);
}

function validateIdentityPart(value: string, label: string): void {
  if (!isValidIdentityPart(value)) {
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
