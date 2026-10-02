import { parseOptions, USAGE } from "./args.mts";
import { formatReport, runChecks } from "./check.mts";
import { fetchLogs, fetchMetrics, readToken, resolveAccount } from "./fetch.mts";
import type { Options } from "./args.mts";
import type { CheckInput, Source } from "./model.mts";

/**
 * `pnpm ops:check`: read Workers Logs, traces' invocation records and container metrics for a
 * window, then print one line if all is well, or one line per rule violation and exit 1.
 *
 * This is a thin wrapper. The rules are pure (`check.mts`) and tested in `pnpm verify`; this file
 * and `fetch.mts` need a live account and stay outside the gate, like `harness:browser`.
 */

const parsed = parseOptions(process.argv.slice(2), Date.now());

if (parsed.kind === "invalid") {
  console.error(`${parsed.reason}\n${USAGE}`);
  process.exit(2);
}

const noToken: Source<never> = {
  status: "unavailable",
  reason: "no CLOUDFLARE_API_TOKEN and no --token-file",
};

async function gather(options: Options): Promise<CheckInput> {
  const token = readToken(options.tokenFile, process.env);
  const base = { worker: options.worker, window: options.window, idleLimitMs: options.idleLimitMs };

  if (token === null) {
    return { ...base, logs: noToken, metrics: noToken };
  }

  const account = await resolveAccount(token, options.account);
  // Container work that started before the window can still be owned by a request just before it.
  const logWindow = { ...options.window, fromMs: options.window.fromMs - options.idleLimitMs };

  const [logs, metrics] = await Promise.all([
    fetchLogs(token, account, logWindow),
    fetchMetrics(token, account, options.worker, options.window),
  ]);

  return { ...base, logs, metrics };
}

const options = parsed.options;

const input = await gather(options);

const findings = runChecks(input);

console.log(
  options.json
    ? JSON.stringify({ worker: input.worker, ok: findings.length === 0, findings }, null, 2)
    : formatReport(input, findings).join("\n"),
);

process.exitCode = findings.length === 0 ? 0 : 1;
