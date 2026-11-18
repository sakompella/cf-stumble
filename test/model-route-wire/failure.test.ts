import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { expect, test } from "vitest";
import { ROUTE_FAILURE, type RouteFailure } from "../../src/model-route-wire/failure.js";

const decisions = [
  { failure: "supervisorUnavailable", retry: true, compact: false },
  { failure: "routeUnreachable", retry: true, compact: false },
  { failure: "streamInterrupted", retry: true, compact: false },
  { failure: "unreadableReply", retry: false, compact: false },
  { failure: "requestTooLarge", retry: false, compact: true },
] as const satisfies ReadonlyArray<{ failure: RouteFailure; retry: boolean; compact: boolean }>;

function failedWith(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "host-model-route",
    provider: "host-model-route",
    model: "host-model-route",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

test("every route failure has a retry and a compaction decision", () => {
  expect(decisions.map(({ failure }) => failure).toSorted()).toEqual(
    Object.keys(ROUTE_FAILURE).toSorted(),
  );
});

test.each(decisions)(
  "Pi decides the route failure $failure by its text: retry is $retry, compaction is $compact",
  ({ failure, retry, compact }) => {
    expect(isRetryableAssistantError(failedWith(ROUTE_FAILURE[failure]))).toBe(retry);
    expect(isContextOverflow(failedWith(ROUTE_FAILURE[failure]))).toBe(compact);
  },
);
