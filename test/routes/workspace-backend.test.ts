import { expect, test } from "vitest";
import { controlRequest, ownerApiResponse, ownerApiSupervisor } from "./helpers.js";

test("the setting is read and changed through the supervisor", async () => {
  const set: string[] = [];

  const supervisor = ownerApiSupervisor({
    getWorkspaceBackend: () => Promise.resolve("cloudflare"),
    setWorkspaceBackend: (backend) => {
      set.push(backend);

      return Promise.resolve({ ok: true, backend });
    },
  });

  const read = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/workspace/backend"),
    supervisor,
  );

  const changed = await ownerApiResponse(
    controlRequest("/api/workspace/backend", JSON.stringify({ backend: "provider" })),
    supervisor,
  );

  expect(await read.json()).toEqual({ ok: true, backend: "cloudflare" });
  expect(await changed.json()).toEqual({ ok: true, backend: "provider" });
  expect(set).toEqual(["provider"]);
});

test("a busy workspace answers 409 and an unknown value 400", async () => {
  const supervisor = ownerApiSupervisor({
    setWorkspaceBackend: () =>
      Promise.resolve({ ok: false, problem: { code: "run-active" } } as const),
  });

  const busy = await ownerApiResponse(
    controlRequest("/api/workspace/backend", JSON.stringify({ backend: "cloudflare" })),
    supervisor,
  );

  const unknown = await ownerApiResponse(
    controlRequest("/api/workspace/backend", JSON.stringify({ backend: "mars" })),
    supervisor,
  );

  expect(busy.status).toBe(409);
  expect(unknown.status).toBe(400);
});
