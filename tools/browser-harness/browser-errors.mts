import type { CdpConnection } from "./cdp.mjs";

/**
 * Everything the browser complains about, collected as it happens.
 *
 * A browser check that only asserts on the DOM passes a page whose script threw halfway through,
 * so the harness watches the three channels a browser uses to report a fault it did not have to
 * stop for: console errors, uncaught exceptions, and log entries. A Content Security Policy
 * violation arrives as a `security` log entry, which is the reason the Log domain is enabled at
 * all — the local server sends the same policy the Worker sends, so a page that outgrows that
 * policy fails here rather than in production.
 */
export function collectBrowserErrors(
  connection: CdpConnection,
  sessionId?: string,
): () => readonly string[] {
  const errors: string[] = [];

  connection.onEvent(
    "Runtime.consoleAPICalled",
    (params) => {
      const level = params.text("type");
      if (level !== "error" && level !== "assert") {
        return;
      }
      const first = params.text("args.0.value") ?? params.text("args.0.description") ?? "";
      errors.push(`console.${level}: ${first}`);
    },
    sessionId,
  );

  connection.onEvent(
    "Runtime.exceptionThrown",
    (params) => {
      const description =
        params.text("exceptionDetails.exception.description") ??
        params.text("exceptionDetails.text") ??
        "unnamed exception";
      errors.push(`uncaught: ${description}`);
    },
    sessionId,
  );

  connection.onEvent(
    "Log.entryAdded",
    (params) => {
      const level = params.text("entry.level");
      const source = params.text("entry.source");
      if (level !== "error" && source !== "security") {
        return;
      }
      const text = params.text("entry.text") ?? "";
      const url = params.text("entry.url");
      const at = url === undefined ? "" : ` (${url})`;
      errors.push(`log[${source ?? "unknown"}/${level ?? "unknown"}]: ${text}${at}`);
    },
    sessionId,
  );

  return () => [...errors];
}
