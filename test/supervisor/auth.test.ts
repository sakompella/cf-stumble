import { expect, test } from "vitest";
import { authorizeSupervisorRequest } from "../../src/supervisor/auth.js";

function request(credential?: string): Request {
  const headers = new Headers();
  if (credential !== undefined) {
    headers.set("authorization", credential);
  }
  return new Request("https://cf-stumble.test/state", { headers });
}

test("a missing secret binding fails closed", () => {
  expect(authorizeSupervisorRequest(request("Bearer supervisor-secret"))).toBe(false);
});

test("a missing, wrong, or empty credential is rejected", () => {
  expect(authorizeSupervisorRequest(request(), "supervisor-secret")).toBe(false);
  expect(authorizeSupervisorRequest(request("Bearer supervisor-secret"), "")).toBe(false);
  expect(authorizeSupervisorRequest(request("Bearer wrong"), "supervisor-secret")).toBe(false);
  expect(authorizeSupervisorRequest(request("Bearer "), "supervisor-secret")).toBe(false);
});

test("the configured bearer credential is accepted", () => {
  expect(authorizeSupervisorRequest(request("Bearer supervisor-secret"), "supervisor-secret")).toBe(
    true,
  );
});
