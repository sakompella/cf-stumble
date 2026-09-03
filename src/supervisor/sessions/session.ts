// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type
export type SessionDocument = string;

export type SessionRecord = {
  readonly sessionId: string;
  readonly document: SessionDocument | undefined;
  readonly revision: number;
  readonly turnActive: boolean;
  readonly turnDeadlineAt: number | undefined;
};

export type SessionProblem =
  | {
      readonly code: "stale-revision";
      readonly sessionId: string;
      readonly currentRevision: number;
    }
  | { readonly code: "turn-conflict"; readonly sessionId: string; readonly deadlineAt: number }
  | { readonly code: "turn-not-active"; readonly sessionId: string }
  | { readonly code: "turn-expired"; readonly sessionId: string; readonly deadlineAt: number }
  | { readonly code: "turn-lease-lost"; readonly sessionId: string };

export type SessionResult =
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly problem: SessionProblem };

export type ExecutedCommand = Readonly<{
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}>;

export type FacetTurnResult = Readonly<{
  readonly document: SessionDocument;
  readonly text: string;
  readonly commands: ReadonlyArray<ExecutedCommand>;
}>;

export type SessionTurnResponse = Readonly<{
  readonly text: string;
  readonly commands: ReadonlyArray<ExecutedCommand>;
  readonly sessionRevision: number;
}>;

export type SessionTurnProblem =
  /** No generation is active, so there is no main harness to run the turn. */
  | { readonly code: "no-active-generation"; readonly sessionId: string }
  | { readonly code: "facet-failed"; readonly sessionId: string }
  | { readonly code: "facet-timeout"; readonly sessionId: string }
  | { readonly code: "malformed-facet-result"; readonly sessionId: string }
  | SessionProblem;

export type SessionTurnResult =
  | { readonly ok: true; readonly response: SessionTurnResponse }
  | { readonly ok: false; readonly problem: SessionTurnProblem };

export type SessionTurnOptions = Readonly<{
  readonly now?: number;
  readonly leaseMs?: number;
  readonly timeoutMs?: number;
}>;

export function parseFacetTurnResult(value: unknown): FacetTurnResult | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["document", "text", "commands"])) {
    return undefined;
  }
  if (typeof value.document !== "string" || typeof value.text !== "string") {
    return undefined;
  }
  if (!Array.isArray(value.commands)) {
    return undefined;
  }

  const commands = value.commands.map(parseCommand);
  return commands.every((command): command is ExecutedCommand => command !== undefined)
    ? { document: value.document, text: value.text, commands }
    : undefined;
}

function parseCommand(value: unknown): ExecutedCommand | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["command", "stdout", "stderr", "exitCode"])) {
    return undefined;
  }
  return typeof value.command === "string" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.exitCode === "number" &&
    Number.isSafeInteger(value.exitCode)
    ? {
        command: value.command,
        stdout: value.stdout,
        stderr: value.stderr,
        exitCode: value.exitCode,
      }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).toSorted();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected.toSorted()[index])
  );
}
