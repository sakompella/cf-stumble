import { expect, test } from "vitest";
import { routeClass, routePattern } from "../../src/routes/route-pattern.js";
import { ownerApiResponse, ownerApiSupervisor } from "./helpers.js";

const classOf = (path: string) => routeClass(routePattern(path));

test.each(["/api/status", "/api/projects", "/api/github/connection", "/api/chatgpt/connection"])(
  "GET %s is record-only and the router answers it without a workspace-reaching Supervisor call",
  async (path) => {
    expect(classOf(path)).toBe("record-only");

    const response = await ownerApiResponse(
      new Request(`https://cf-stumble.test${path}`),
      ownerApiSupervisor(),
    );

    expect(response.status).toBe(200);
  },
);

test("a route the table does not list is record-only", () => {
  expect(classOf("/api/projects/sample-project-one/rename")).toBe("record-only");
});
