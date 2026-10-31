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

test.each([
  "/api/projects/sample-project-one/messages",
  "/api/projects/sample-project-one/events",
  "/api/projects/sample-project-one/abort",
  "/api/projects/sample-project-one/thread/fresh",
  "/api/projects/sample-project-one/disconnect",
  "/api/projects/connect",
  "/api/github/connection/refresh",
  "/api/workspace/reset",
  "/api/generations/submit",
])("%s may reach the workspace", (path) => {
  expect(classOf(path)).toBe("workspace");
});

test("a route the table does not list is unclassified, and the router does not answer it", async () => {
  const path = "/api/projects/sample-project-one/rename";

  expect(classOf(path)).toBeUndefined();

  const response = await ownerApiResponse(
    new Request(`https://cf-stumble.test${path}`, { method: "POST" }),
    ownerApiSupervisor(),
  );

  expect(response.status).toBe(404);
});
