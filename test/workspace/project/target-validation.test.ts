import { expect, test } from "vitest";
import { makeTarget } from "./target-helpers.js";

test("startExec limits concurrent operations and releases a settled slot", async () => {
  const { target } = makeTarget();

  const started = await Promise.all(
    Array.from({ length: 8 }, () => target.startExec({ command: "x" })),
  );

  expect(started.every((result) => result.ok)).toBe(true);

  await expect(target.startExec({ command: "x" })).resolves.toEqual({
    ok: false,
    error: { code: "too-many-operations" },
  });

  const first = started[0]!;

  if (!first.ok) throw new Error("expected startExec to succeed");
  await first.value.events.cancel();

  await expect(target.startExec({ command: "x" })).resolves.toMatchObject({ ok: true });
});

test("kill rejects a malformed operation id", async () => {
  const { target } = makeTarget();

  await expect(target.kill("not-a-uuid:0")).resolves.toEqual({
    ok: false,
    error: { code: "invalid-request" },
  });
});
