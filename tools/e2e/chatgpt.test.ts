import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answeredCalls,
  answersOf,
  cachedShare,
  turnFindings,
  type AnsweredCall,
} from "./chatgpt.mts";

const MODEL = "gpt-6.1-terra";

const chatgpt = { provider: "chatgpt", model: MODEL, fellBack: false };

type Served = Readonly<{
  provider: string;
  model: string;
  diagnostics?: readonly Readonly<{ type: string; details: Readonly<{ reason: string }> }>[];
}>;

function entry(served: Served) {
  return { id: 1, kind: "pi.assistant", model: [{ role: "assistant", ...served }] };
}

function call(cachedTokens: number, toolsHash = "t1"): AnsweredCall {
  return {
    event: "chatgpt.model-call",
    outcome: "ok",
    model: MODEL,
    promptTokens: 1000,
    cachedTokens,
    instructionsHash: "i1",
    toolsHash,
  };
}

describe("the ChatGPT turn check", () => {
  it("passes a turn whose calls all came from the stage's model with one prompt prefix", () => {
    const calls = [call(0), call(900), call(950)];

    assert.deepEqual(turnFindings(MODEL, [chatgpt, chatgpt, chatgpt], calls), []);
    assert.equal(cachedShare(calls), "61.7% (1850/3000)");
  });

  it("names a Workers AI answer, a fallback diagnostic and a changed tools fingerprint", () => {
    const answers = [chatgpt, { provider: "workers-ai", model: "kimi", fellBack: true }];

    assert.deepEqual(turnFindings(MODEL, answers, [call(0), call(0, "t2")]), [
      `answer 2 came from workers-ai kimi, not chatgpt ${MODEL}`,
      "answer 2 has a provider-fallback diagnostic",
      "toolsHash changed within the turn: t1, t2",
    ]);
  });

  it("fails when the logs lack calls or fingerprints", () => {
    const { toolsHash: _dropped, ...bare } = call(0);

    assert.deepEqual(turnFindings(MODEL, [chatgpt, chatgpt], [bare]), [
      "Workers Logs show 1 chatgpt.model-call ok events for 2 answers",
      "a chatgpt.model-call event has no toolsHash",
    ]);
  });
});

describe("the ChatGPT turn's sources", () => {
  it("reads answered calls from Workers Logs and skips refusals", () => {
    const ok = {
      source: {
        event: "chatgpt.model-call",
        outcome: "ok",
        model: MODEL,
        promptTokens: 1000,
        cachedTokens: 10,
        instructionsHash: "i1",
        toolsHash: "t1",
      },
    };

    const refused = { source: { event: "chatgpt.model-call", outcome: "refused", status: 401 } };

    assert.deepEqual(answeredCalls({ result: { events: { events: [refused, ok] } } }), [call(10)]);
  });

  it("reads who answered from the assistant entries", () => {
    assert.deepEqual(
      answersOf([
        entry({ provider: "chatgpt", model: MODEL }),
        entry({
          provider: "workers-ai",
          model: "kimi",
          diagnostics: [
            { type: "provider-fallback", details: { reason: "chatgpt-not-connected" } },
          ],
        }),
      ]),
      [chatgpt, { provider: "workers-ai", model: "kimi", fellBack: true }],
    );
  });
});
