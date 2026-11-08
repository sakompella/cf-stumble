import * as Result from "effect/Result";
import { expect, test } from "vitest";
import {
  parseRequest,
  type ModelRouteRequest,
  type ValidationFailure,
} from "../src/model-route-request.js";

function rejected(reason: string): Result.Result<ModelRouteRequest, ValidationFailure> {
  return Result.fail({ ok: false, error: { code: "invalid-request", reason } });
}

const USER = { role: "user", content: "Hi" } as const;

test("rejects a request that includes a field that picks the provider", () => {
  for (const field of ["model", "reasoning_effort", "credentials", "endpoint", "provider"]) {
    expect(parseRequest({ messages: [USER], [field]: "forbidden" }), field).toEqual(
      rejected(`request must not include provider field: ${field}`),
    );
  }
});
