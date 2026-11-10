import type { TimeWindow } from "../ops-check/check.mts";
import { fetchModelCalls } from "../ops-check/telemetry.mts";
import type { Account } from "./cloudflare.mts";

export async function reportModelCalls(account: Account, worker: string, window: TimeWindow) {
  const { calls, sample } = await fetchModelCalls(account.token, account.id, worker, window);

  console.error(`e2e: ${calls.length} model calls${sample ? " (a sample)" : ""}`);
}
