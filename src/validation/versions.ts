import { isJsonObjectValue, isJsonPrimitive, type JsonPrimitive, type JsonValue } from "../json.js";
import type { ValidationCase } from "./results.js";

const GATE_POLICY = {
  name: "executor-compatibility-regression-gate",
  version: 1,
  baseline: "a candidate must preserve every case that passes on the live generation",
  mandatoryCanary: "a canary must pass individually on both the live generation and the candidate",
  preflight: "every primitive and self-edit check must pass before the corpus runs",
  pinnedCanarySet: "mandatory canaries come from supervisor-owned pinned definitions",
  pinnedCanaryCorpus: "the corpus must contain each pinned canary without content changes",
  inconclusive: "an inconclusive case cannot satisfy a gate requirement",
  executorFailure: "an executor throw or timeout is inconclusive",
  emptyCorpus: "an empty corpus is inconclusive",
  noPassingBaseline: "a baseline with no passing case is inconclusive",
} as const;

function jsonString(value: JsonPrimitive): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("could not encode JSON primitive");
  }
  return encoded;
}

/** Canonical JSON makes version hashes independent of object insertion order. */
function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    const entries: readonly JsonValue[] = value;
    return `[${entries.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isJsonObjectValue(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .flatMap((key) => {
        const entry = value[key];
        return entry === undefined ? [] : [`${jsonString(key)}:${canonicalJson(entry)}`];
      })
      .join(",")}}`;
  }
  if (isJsonPrimitive(value)) {
    return jsonString(value);
  }
  throw new Error("internal error: unknown JSON value variant");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashVersion(namespace: string, content: JsonValue): Promise<string> {
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
