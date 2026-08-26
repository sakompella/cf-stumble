import type { ValidationCase } from "./results.js";

const GATE_POLICY = {
  name: "executor-compatibility-regression-gate",
  version: 1,
  baseline: "a candidate must preserve every case that passes on the live generation",
  mandatoryCanary: "a canary must pass on both the live generation and the candidate",
  inconclusive: "an inconclusive case cannot satisfy a gate requirement",
  emptyCorpus: "an empty corpus is inconclusive",
  noPassingBaseline: "a baseline with no passing case is inconclusive",
} as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: object): value is RecordValue {
  return !Array.isArray(value);
}

function jsonString(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("could not encode string as JSON");
  }
  return encoded;
}

/** Canonical JSON makes version hashes independent of object insertion order. */
function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return jsonString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("version content must contain finite numbers");
      }
      return String(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
      }
      if (!isRecord(value)) {
        throw new TypeError("version content must contain plain records");
      }
      return `{${Object.keys(value)
        .toSorted()
        .flatMap((key) => {
          const entry = value[key];
          return entry === undefined
            ? []
            : [`${jsonString(key)}:${canonicalJson(entry)}`];
        })
        .join(",")}}`;
    case "undefined":
      return "null";
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError("version content must be JSON-compatible");
  }
  throw new TypeError("version content must be JSON-compatible");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashVersion(namespace: string, content: unknown): Promise<string> {
  const input = new TextEncoder().encode(`${namespace}\n${canonicalJson(content)}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

/** Hash the complete case set, including names, sessions, and canary markings. */
export function computeCorpusVersion(corpus: readonly ValidationCase[]): Promise<string> {
  const cases = corpus
    .map((validationCase) => ({
      name: validationCase.name,
      mandatoryCanary: validationCase.mandatoryCanary,
      session: validationCase.session,
    }))
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return hashVersion("cf-stumble/corpus/v1", cases);
}

/** Hash the explicit policy descriptor, so a policy change produces a new gate binding. */
export function computeGateVersion(): Promise<string> {
  return hashVersion("cf-stumble/gate/v1", GATE_POLICY);
}
