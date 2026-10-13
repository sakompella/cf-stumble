import { ToolError } from "./error.mts";

export type Options = Readonly<{
  origin: string;
  tokenFile: string;
  profile: string;
  firefox: string;
  timeoutMs: number;
  inspect: boolean;
  account: string;
  headed: boolean;
}>;

const VALUE_FLAGS = [
  "--account",
  "--origin",
  "--token-file",
  "--profile",
  "--firefox",
  "--timeout-ms",
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

function isValueFlag(flag: string): flag is ValueFlag {
  return VALUE_FLAGS.some((known) => known === flag);
}

export function parseOptions(args: readonly string[]): Options {
  const defaults = defaultOptions();
  const values = new Map<ValueFlag, string>();
  const switches = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";

    if (flag === "--headed" || flag === "--inspect") {
      switches.add(flag);
      continue;
    }

    const value = args[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new ToolError("Expected an option value");
    }

    if (!isValueFlag(flag)) throw new ToolError("Unknown option");

    values.set(flag, value);
    index += 1;
  }

  const inspect = switches.has("--inspect");
  const origin = values.get("--origin") ?? "";

  return {
    origin: inspect && origin === "" ? "" : parseOrigin(origin),
    tokenFile: values.get("--token-file") ?? defaults.tokenFile,
    profile: required(values.get("--profile") ?? "", "--profile"),
    firefox: values.get("--firefox") ?? defaults.firefox,
    timeoutMs: parseTimeout(Number(values.get("--timeout-ms") ?? defaults.timeoutMs)),
    inspect,
    account: values.get("--account") ?? "",
    headed: switches.has("--headed"),
  };
}

function required(value: string, flag: string): string {
  if (value === "") throw new ToolError(`${flag} is required`);

  return value;
}

function parseOrigin(origin: string): string {
  const url = new URL(required(origin, "--origin"));

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ToolError("Origin must be an HTTPS origin");
  }

  return url.origin;
}

function parseTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ToolError("Timeout must be a positive integer");
  }

  return timeoutMs;
}

export function bidiListeningUrl(line: string): string | undefined {
  return /WebDriver BiDi listening on (ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/[^\s]*)?)/u.exec(
    line,
  )?.[1];
}

export function isCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.origin === "http://127.0.0.1:1455" &&
      url.pathname === "/auth/callback" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function isSessionStorage(name: string): boolean {
  return /^https\+\+\+(?:auth\.openai\.com|chatgpt\.com|openai\.com)(?:$|[+^])/u.test(name);
}

export function isApprovalText(text: string): boolean {
  return /^(continue|allow|authorize|approve|accept)(?:\b|$)/iu.test(text.trim());
}

export function redactPageText(text: string): string {
  return text
    .replaceAll(/https?:\/\/[^\s<>]+/gu, (value) => value.split(/[?#]/u)[0] ?? "[URL]")
    .replaceAll(/(?:eyJ|sk-|access_token|refresh_token|code=)[^\s]+/gu, "[redacted]")
    .slice(0, 8000);
}

function defaultOptions() {
  return {
    tokenFile: ".audit/local/access-service-token.json",
    firefox: "/Applications/Firefox.app/Contents/MacOS/firefox",
    timeoutMs: 120_000,
  };
}

export function isSessionFile(name: string): boolean {
  return [
    "cookies.sqlite",
    "cookies.sqlite-wal",
    "cookies.sqlite-shm",
    "cert9.db",
    "key4.db",
    "pkcs11.txt",
  ].includes(name);
}

export function matchesAccount(label: string, names: readonly string[], account: string): boolean {
  const wanted = account.trim().toLowerCase();

  if (wanted === "") {
    return true;
  }

  return wanted.includes("@")
    ? label.toLowerCase().includes(wanted)
    : names.some((name) => name.trim().toLowerCase() === wanted);
}
