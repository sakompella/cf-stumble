import * as Result from "effect/Result";
import { expect, test } from "vitest";
import {
  parseRequest,
  type ModelRouteRequest,
  type RouteMessage,
  type RouteWire,
  type ValidationFailure,
} from "../../src/model-route-wire/request.js";

function rejected(reason: string): Result.Result<ModelRouteRequest, ValidationFailure> {
  return Result.fail({ ok: false, error: { code: "invalid-request", reason } });
}

const USER = { role: "user", content: "Hi" } as const;

test("rejects a request that includes a field that picks the provider", () => {
  for (const field of ["model", "reasoning_effort", "credentials", "endpoint", "provider"]) {
    const parsed = parseRequest({ messages: [USER], [field]: "forbidden" });
    const failure = Result.isFailure(parsed) ? parsed.failure : undefined;

    expect(failure?.error, field).toMatchObject({ code: "invalid-request" });
    expect(failure?.error.reason, field).toContain(field);
  }
});

class CyclicWire {
  readonly messages: RouteMessage[] = [{ role: "user", content: "Hi" }];
  readonly self = this;
}

test("refuses a request whose values JSON.stringify cannot serialize", () => {
  const parameters = { maximum: 1n } satisfies object;

  const requests: readonly RouteWire[] = [
    {
      messages: [USER],
      tools: [{ type: "function", function: { name: "t", description: "", parameters } }],
    },
    new CyclicWire(),
  ];

  for (const request of requests) {
    expect(parseRequest(request)).toEqual(rejected("request must be JSON-serializable"));
  }
});
