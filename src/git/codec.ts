import { Result, panic } from "better-result";
import { assertNever } from "./types.js";
import type { GitObject, GitObjectType } from "./types.js";
import { GitObjectDecodeError } from "./errors.js";
import type { GitObjectDecodeCondition } from "./errors.js";
import { concat, decodeUtf8, encodeUtf8 } from "./binary.js";
import { encodeCommit, decodeCommit } from "./commit.js";
import { encodeTree, decodeTree } from "./tree.js";

/**
 * Encoding takes a {@link GitObject}, whose object ids are already branded and whose modes are
 * already a closed union, so its remaining preconditions (a well-formed signature, a tree name git
 * will accept) are the caller's to meet. It keeps throwing: a violation is a programmer mistake,
 * not a condition to report. Decoding is the untrusted direction, and that is what returns a
 * `Result`.
 */
export function encodeObject(object: GitObject): Uint8Array {
  switch (object.type) {
    case "blob":
      return concat(encodeUtf8(`blob ${object.data.byteLength}\0`, "object header"), object.data);
    case "tree":
      return encodeTree(object.entries);
    case "commit":
      return encodeCommit(object.commit);
    default:
      return assertNever(object, "git object encoding");
  }
}

const OBJECT_HEADER = /^(blob|tree|commit) ([0-9]+)$/u;

export function decodeObject(bytes: Uint8Array): Result<GitObject, GitObjectDecodeError> {
  const terminator = bytes.indexOf(0);
  if (terminator < 0) {
    return Result.err(headerError("missing-terminator", "missing header terminator"));
  }

  const headerText = decodeUtf8(bytes.subarray(0, terminator), "header", "object header");
  if (Result.isError(headerText)) {
    return headerText;
  }
  const header = decodeHeader(headerText.value);
  if (Result.isError(header)) {
    return header;
  }

  const body = bytes.subarray(terminator + 1);
  if (body.byteLength !== header.value.length) {
    return Result.err(
      headerError(
        "length-mismatch",
        `header declares ${header.value.length} bytes, got ${body.byteLength}`,
      ),
    );
  }

  switch (header.value.type) {
    case "blob":
      return Result.ok({ type: "blob", data: body.slice() });
    case "tree":
      return decodeTree(body);
    case "commit":
      return decodeCommit(body);
    default:
      return assertNever(header.value.type, "git object decoding");
  }
}

type ObjectHeader = {
  readonly type: GitObjectType;
  readonly length: number;
};

/** The `"<type> <length>"` prefix, validated but not yet checked against the body it describes. */
function decodeHeader(text: string): Result<ObjectHeader, GitObjectDecodeError> {
  const match = OBJECT_HEADER.exec(text);
  if (match === null) {
    return Result.err(
      headerError("malformed-header", `unrecognised header ${JSON.stringify(text)}`),
    );
  }

  const typeText = match[1];
  const lengthText = match[2];
  if (typeText === undefined || lengthText === undefined) {
    // Both groups are unconditional in OBJECT_HEADER, so a match always captures them.
    panic(
      `git object header ${JSON.stringify(text)} matched ${String(OBJECT_HEADER)} without capturing both groups`,
    );
  }
  if (!isGitObjectType(typeText)) {
    // OBJECT_HEADER's first group is an alternation over exactly these three types.
    panic(`git object header type ${JSON.stringify(typeText)} escaped ${String(OBJECT_HEADER)}`);
  }
  if (lengthText.length > 1 && lengthText.startsWith("0")) {
    return Result.err(headerError("non-canonical-length", `non-canonical length ${lengthText}`));
  }
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length)) {
    return Result.err(headerError("invalid-length", `invalid length ${lengthText}`));
  }
  return Result.ok({ type: typeText, length });
}

function headerError(condition: GitObjectDecodeCondition, detail: string): GitObjectDecodeError {
  return new GitObjectDecodeError({ layer: "header", condition, detail });
}

function isGitObjectType(value: string): value is GitObjectType {
  return value === "blob" || value === "tree" || value === "commit";
}
