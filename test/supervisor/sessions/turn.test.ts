/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { activeSupervisor } from "../helpers.js";

const NOW = 1_700_000_000_000;

afterEach(async () => {
  await reset();
});

/** No generation is active, so no main harness exists to run the turn and none is invented. */
test("a turn with no active generation reports that and leaves the session untouched", async () => {
  const control = env.SUPERVISOR.getByName("session-turn-no-active-generation");

  const result = await control.runSessionTurn("session-a", "first", 0, { now: NOW });

  expect(result).toEqual({
    ok: false,
    problem: { code: "no-active-generation", sessionId: "session-a" },
  });
  expect(await control.getSession("session-a")).toMatchObject({
    document: undefined,
    revision: 0,
    turnActive: false,
  });
});

test("the first turn saves a document and returns the facet reply", async () => {
  const control = await activeSupervisor("session-turn-first");

  const result = await control.runSessionTurn("session-a", "first", 0, { now: NOW });

  expect(result).toEqual({
    ok: true,
    response: { text: "reply:first", commands: [], sessionRevision: 1 },
  });
  expect(await control.getSession("session-a")).toMatchObject({
    document: JSON.stringify({ turns: ["first"] }),
    revision: 1,
    turnActive: false,
  });
});

test("a turn returns cloneable executed command evidence", async () => {
  const control = await activeSupervisor("session-turn-command");

  const result = await control.runSessionTurn("session-a", "command", 0, { now: NOW });

  expect(result).toEqual({
    ok: true,
    response: {
      text: "reply:command",
      commands: [{ command: "echo fake", stdout: "fake\n", stderr: "", exitCode: 0 }],
      sessionRevision: 1,
    },
  });
});

test("the second turn receives the first turn document", async () => {
  const control = await activeSupervisor("session-turn-continuity");
  await control.runSessionTurn("session-a", "first", 0, { now: NOW });

  const result = await control.runSessionTurn("session-a", "second", 1, { now: NOW });

  expect(result).toMatchObject({
    ok: true,
    response: { text: "reply:second", sessionRevision: 2 },
  });
  expect(await control.getSession("session-a")).toMatchObject({
    document: JSON.stringify({ turns: ["first", "second"] }),
    revision: 2,
  });
});

test("a failed facet turn releases its lease without advancing revision", async () => {
  const control = await activeSupervisor("session-turn-failure");

  const result = await control.runSessionTurn("session-a", "fail", 0, { now: NOW });

  expect(result).toEqual({ ok: false, problem: { code: "facet-failed", sessionId: "session-a" } });
  expect(await control.getSession("session-a")).toMatchObject({
    revision: 0,
    turnActive: false,
  });
});

test("a stale expected revision is rejected before mounting the facet", async () => {
  const control = await activeSupervisor("session-turn-stale");
  await control.runSessionTurn("session-a", "first", 0, { now: NOW });

  const result = await control.runSessionTurn("session-a", "stale", 0, { now: NOW });

  expect(result).toEqual({
    ok: false,
    problem: { code: "stale-revision", sessionId: "session-a", currentRevision: 1 },
  });
});

test("a malformed facet result is rejected and releases its lease", async () => {
  const control = await activeSupervisor("session-turn-malformed");

  const result = await control.runSessionTurn("session-a", "malformed", 0, { now: NOW });

  expect(result).toEqual({
    ok: false,
    problem: { code: "malformed-facet-result", sessionId: "session-a" },
  });
  expect(await control.getSession("session-a")).toMatchObject({
    revision: 0,
    turnActive: false,
  });
});

test("an expired lease takeover cannot be cleared by the old turn", async () => {
  const control = await activeSupervisor("session-turn-takeover");
  const oldTurn = control.runSessionTurn("session-a", "timeout", 0, {
    now: NOW,
    leaseMs: 10,
    timeoutMs: 100,
  });
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 20);
  });

  const takeover = await control.startSessionTurn("session-a", 0, NOW + 10, 30_000);
  expect(takeover).toMatchObject({ ok: true, session: { turnActive: true } });
  const committed = await control.finishSessionTurn("session-a", 0, "taken over", NOW + 10);
  expect(committed).toMatchObject({ ok: true, session: { revision: 1 } });

  expect(await oldTurn).toEqual({
    ok: false,
    problem: { code: "facet-timeout", sessionId: "session-a" },
  });
  expect(await control.getSession("session-a")).toMatchObject({
    document: "taken over",
    revision: 1,
    turnActive: false,
  });
});
