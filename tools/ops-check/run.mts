import { parseOptions, USAGE } from "./args.mts";
import { formatReport, runChecks } from "./check.mts";
import {
  fetchApplications,
  fetchInstances,
  fetchLogs,
  fetchMetrics,
  readToken,
  resolveAccount,
} from "./fetch.mts";
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

/** Every source failed for one reason: the check can say nothing, and says so for each. */
function allUnavailable(
  base: Omit<CheckInput, "logs" | "metrics" | "instances">,
  reason: string,
): CheckInput {
  const failed: Source<never> = { status: "unavailable", reason };

  return { ...base, logs: failed, metrics: failed, instances: failed };
}

async function gather(options: Options): Promise<CheckInput> {
  const base = {
    worker: options.worker,
    nowMs: Date.now(),
    window: options.window,
    idleLimitMs: options.idleLimitMs,
  };

  const token = readToken(options.tokenFile, process.env);

  if (token.status === "unavailable") {
    return allUnavailable(base, token.reason);
  }

  const account = await resolveAccount(token.data, options.account, process.env);

  if (account.status === "unavailable") {
    return allUnavailable(base, account.reason);
  }

  // Container work that started before the window can still be owned by a request just before it.
  const logWindow = { ...options.window, fromMs: options.window.fromMs - options.idleLimitMs };

  const [logs, applications] = await Promise.all([
    fetchLogs(token.data, account.data, options.worker, logWindow),
    fetchApplications(token.data, account.data, options.worker),
  ]);

  if (applications.status === "unavailable") {
    return { ...base, logs, metrics: applications, instances: applications };
  }

  const [metrics, instances] = await Promise.all([
    fetchMetrics(token.data, account.data, applications.data, options.window),
    fetchInstances(token.data, account.data, applications.data),
  ]);

  return { ...base, logs, metrics, instances };
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
