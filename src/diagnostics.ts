import { REDACTED, redactCredentials } from "./github/index.js";

const CAUSE_TEXT_LIMIT = 400;

const TIMEOUT_MESSAGE_PATTERN = /\btime(?:d)?[ -]?out\b/iu;

export function isTimeoutFailure(cause: unknown): boolean {
  try {
    if (!(cause instanceof Error)) return false;

    return cause.name === "TimeoutError" || TIMEOUT_MESSAGE_PATTERN.test(cause.message);
  } catch {
    return false;
  }
}

const UNPRINTABLE_CAUSE = "[unprintable cause]";

const JWT_PATTERN = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/gu;

export function redactLogText(text: string, knownToken?: string): string {
  return redactCredentials(text, knownToken).replaceAll(JWT_PATTERN, REDACTED);
}

export function redactedExcerpt(text: string, knownToken?: string): string {
  return redactLogText(text, knownToken).slice(0, CAUSE_TEXT_LIMIT);
}

function causeText(cause: unknown, knownToken: string | undefined): string {
  try {
    const message = cause instanceof Error ? cause.message : String(cause);

    return redactedExcerpt(message, knownToken);
  } catch {
    return UNPRINTABLE_CAUSE;
  }
}

export function logRedactedCause(context: string, cause: unknown, knownToken?: string): void {
  console.error(`${context}: ${causeText(cause, knownToken)}`);
}

type LogValue = string | number | boolean | null;

export type LogFields = Readonly<Record<string, LogValue>>;

export type LogLevel = "info" | "warn" | "error";

const FIELD_TEXT_LIMIT = 200;

const CONSOLE_METHOD = { info: "log", warn: "warn", error: "error" } as const;

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const redacted = Object.entries(fields).map(([key, value]) =>
    isText(value) ? [key, redactLogText(value).slice(0, FIELD_TEXT_LIMIT)] : [key, value],
  );

  console[CONSOLE_METHOD[level]]({
    ...Object.fromEntries(redacted),
    event,
    level,
    ts: new Date().toISOString(),
  });
}

function isText(value: LogValue): value is string {
  return typeof value === "string";
}
