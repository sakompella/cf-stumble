import type { Case, Reply } from "./http-case.mts";
import { effectiveMethod } from "./http-routes.mts";
import type { Violation } from "./http-oracle.mts";

export function lenientEntriesQuery(probe: Case, reply: Reply): Violation | undefined {
  const url = URL.parse(`https://worker.invalid${probe.path}`);

  if (url === null || !/^\/api\/projects\/[^/]+\/entries$/u.test(url.pathname)) return undefined;

  if (effectiveMethod(probe.method) !== "GET" || reply.status >= 400) return undefined;

  const limit = url.searchParams.get("limit");

  const valid =
    limit !== null && /^\d{1,15}$/u.test(limit) && Number(limit) >= 1 && Number(limit) <= 100;

  return limit === null || valid
    ? undefined
    : {
        oracle: "invalid-limit-accepted",
        detail: `limit=${limit.slice(0, 40)} answered ${reply.status}`,
      };
}
