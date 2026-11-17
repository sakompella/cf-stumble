import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { expect, test } from "vitest";
import { ROUTE_FAILURE, type RouteFailure } from "../../src/model-route-wire/failure.js";

const decisions = [
  { failure: "supervisorUnavailable", retry: true },
  { failure: "routeUnreachable", retry: true },
  { failure: "streamInterrupted", retry: true },
  { failure: "unreadableReply", retry: false },
] as const satisfies ReadonlyArray<{ failure: RouteFailure; retry: boolean }>;

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

test("every route failure has a retry decision", () => {
  expect(decisions.map(({ failure }) => failure).toSorted()).toEqual(
    Object.keys(ROUTE_FAILURE).toSorted(),
  );
});

test.each(decisions)(
  "Pi decides the route failure $failure by its text: retry is $retry",
  ({ failure, retry }) => {
    expect(isRetryableAssistantError(failedWith(ROUTE_FAILURE[failure]))).toBe(retry);
  },
);
