import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { activateGeneration } from "../helpers.js";
import { readyScripted, SCRIPTED_COMMITS, servingScripted } from "./serving-fixture.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test.each([
  ["mounted and attaching", "hello", "attach-held", 1000],
  ["submitting", "hold the submit", "submit-held", 0],
] as const)(
  "a generation that activates while the message is %s gets the message once",
  async (_stage, content, gate, attachDelayMs) => {
    const control = await servingScripted(`conversations-switch-${gate}`, attachDelayMs);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const second = await readyScripted(control, SCRIPTED_COMMITS[1]);

    const submitting = control.submitProjectMessage("harness", content, "r1", 30);

    await vi.waitFor(
      () => {
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: `facet.${gate}` }));
      },
      { timeout: 10_000 },
    );
    await activateGeneration(control, second);

    expect(await submitting).toEqual({ ok: true, submissionId: 1 });
    expect(await control.submitProjectMessage("harness", "again", "r2", 30)).toEqual({
      ok: true,
      submissionId: 2,
    });
  },
);

test("a message is refused when the generation still fails after the retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const control = await servingScripted("conversations-switch-refused");

  await control.submitProjectMessage("harness", "refuse the next attach", "r0", 30);

  expect(await control.submitProjectMessage("harness", "hello", "r1", 30)).toEqual({
    ok: false,
    problem: { code: "generation-failed" },
  });
});

test("an events stream from the replaced facet ends when another generation activates", async () => {
  const control = await servingScripted("conversations-switch-events");
  const second = await readyScripted(control, SCRIPTED_COMMITS[1]);
  await control.submitProjectMessage("harness", "hold the events open", "r1", 30);
  await control.abortProjectRun("harness");
  const result = await control.projectEvents("harness");

  if (!result.ok) throw new Error(`the events must open: ${result.problem.code}`);
  const reader = result.events.getReader();
  await reader.read();

  await activateGeneration(control, second);

  let next = await reader.read();

  while (!next.done) next = await reader.read();

  expect(next.done).toBe(true);
});
