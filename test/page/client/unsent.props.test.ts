import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { Outgoing } from "../../../src/page/client/outgoing.js";
import { init, update } from "../../../src/page/client/update.js";

const PROJECT_IDS = ["repo", "harness"] as const;

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

type Send = Readonly<{ requestId: string; projectId: string; text: string }>;

type Run = {
  model: Model;
  unminted: Send[];
  inFlight: Send[];
  owed: Send[];
  lost: Send[];
  sent: number;
};

const ACTIONS = ["send", "mint", "fail", "succeed", "switch"] as const;

function currentProject(model: Model): string {
  return Option.getOrThrow(model.maybeProjectId);
}

function shownIn(model: Model, projectId: string): string {
  return currentProject(model) === projectId ? model.prompt : (model.drafts[projectId] ?? "");
}

function apply(run: Run, message: Message): void {
  run.model = update(run.model, message).model;
}

function mint(run: Run, send: Send): void {
  apply(run, Message.MintedRequestId({ ...send, content: send.text }));
  (currentProject(run.model) === send.projectId ? run.inFlight : run.owed).push(send);
}

function fail(run: Run, send: Send, rejected: boolean): void {
  (rejected ? run.owed : run.lost).push(send);

  apply(
    run,
    rejected
      ? Message.RejectedSend({ requestId: send.requestId, wording: "busy" })
      : Message.FailedSend({ requestId: send.requestId, detail: "offline" }),
  );
}

function sendFromPrompt(run: Run): void {
  run.sent += 1;

  const send = {
    requestId: `r${run.sent}`,
    projectId: currentProject(run.model),
    text: `<t${run.sent}>`,
  };

  run.unminted.push(send);
  apply(run, Message.UpdatedPrompt({ value: send.text }));
  apply(run, Message.ClickedSendTurn());
}

function takeAny(tc: hegel.TestCase, sends: Send[]): Send {
  const index = tc.draw(gs.integers({ minValue: 0, maxValue: sends.length - 1 }));

  return sends.splice(index, 1)[0]!;
}

function step(tc: hegel.TestCase, run: Run): void {
  const action = tc.draw(gs.sampledFrom(ACTIONS));

  if (action === "send" && run.model.prompt === "") sendFromPrompt(run);
  else if (action === "mint" && run.unminted.length > 0) mint(run, takeAny(tc, run.unminted));
  else if (action === "fail" && run.inFlight.length > 0)
    fail(run, takeAny(tc, run.inFlight), tc.draw(gs.booleans()));
  else if (action === "succeed" && run.inFlight.length > 0)
    apply(
      run,
      Message.SucceededSend({ requestId: takeAny(tc, run.inFlight).requestId, submissionId: 1 }),
    );
  else if (action === "switch")
    apply(run, Message.ClickedProject({ projectId: tc.draw(gs.sampledFrom(PROJECT_IDS)) }));
}

function settle(run: Run): void {
  for (const send of run.unminted.splice(0)) mint(run, send);

  for (const send of run.inFlight.splice(0)) fail(run, send, false);
}

test("a refused text comes back in its own project's prompt and a lost one stays in its own project's conversation, whatever the interleaving", () => {
  hegel.test(
    (tc) => {
      const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS }));

      const run: Run = {
        model: listed.model,
        unminted: [],
        inFlight: [],
        owed: [],
        lost: [],
        sent: 0,
      };

      for (let index = tc.draw(gs.integers({ minValue: 0, maxValue: 24 })); index > 0; index -= 1)
        step(tc, run);

      settle(run);

      for (const send of run.owed)
        for (const projectId of PROJECT_IDS)
          expect(shownIn(run.model, projectId).split(send.text).length - 1, send.text).toBe(
            projectId === send.projectId ? 1 : 0,
          );

      for (const send of run.lost) {
        const rows = run.model.outgoing.filter(
          (item) =>
            Outgoing.guards.Unconfirmed(item) &&
            item.requestId === send.requestId &&
            item.projectId === send.projectId,
        );

        expect(rows, send.text).toHaveLength(1);

        for (const projectId of PROJECT_IDS)
          expect(shownIn(run.model, projectId), send.text).not.toContain(send.text);
      }
    },
    { testCases: 300 },
  );
});
