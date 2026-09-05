import { expect, test } from "vitest";
import {
  createPiAgentTurnState,
  estimateThreadTokens,
  GENERATION_0_COMPACTION,
  needsCompaction,
  runPiAgentTurn,
} from "../../../src/facet/generation-0/index.js";
import { ROUTE_MODEL } from "../../../src/facet/generation-0/route-stream.js";
import { makeFacetExecutionEnv } from "./execution-env-target.js";
import { assistant, scriptedModel as model, scriptedStream } from "./scripted-model.js";
import { createAssistantMessageEventStream } from "@cf-stumble/pi";
import type { AgentMessage, StreamFn } from "@cf-stumble/pi";
import type { CompactionPolicy } from "../../../src/facet/generation-0/index.js";

/**
 * A budget small enough that any conversation exceeds it, and a retention of zero so the cut point
 * keeps only what Pi insists on keeping. This is what makes the proof deterministic: it forces
 * compaction from four messages instead of from a conversation long enough to reach a real budget.
 */
const FORCED: CompactionPolicy = {
  contextBudgetTokens: 1,
  settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
};

const SUMMARY = "## Analysis\nThe user asked about the login bug and the fix landed in auth.ts.";

/** What the route answers when it cannot produce a reply at all. */
function failedStream() {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "error",
    reason: "error",
    error: { ...assistant([], "stop"), stopReason: "error", errorMessage: "the route is down" },
  });
  return stream;
}

function conversation(): AgentMessage[] {
  return [
    { role: "user", content: "Find the login bug.", timestamp: 1 },
    assistant([{ type: "text", text: "It is in auth.ts, line 40." }], "stop"),
    { role: "user", content: "Fix it.", timestamp: 2 },
    assistant([{ type: "text", text: "Fixed and the check passes." }], "stop"),
  ];
}

/**
 * The fact T7 had to settle before claiming this criterion. `ROUTE_MODEL` reports no context
 * window, and Pi decides with `contextTokens > contextWindow - reserveTokens`, so passing that zero
 * through would make an empty conversation exceed the threshold and every turn compact. This
 * generation therefore compacts against the budget it declares.
 */
test("the route's zero context window would compact everything, so the declared budget is used", () => {
  expect(ROUTE_MODEL.contextWindow).toBe(0);
  expect(
    needsCompaction([], { ...GENERATION_0_COMPACTION, contextBudgetTokens: 0 }),
    "an empty conversation exceeds a zero window",
  ).toBe(true);

  expect(needsCompaction([], GENERATION_0_COMPACTION)).toBe(false);
  expect(needsCompaction(conversation(), GENERATION_0_COMPACTION)).toBe(false);
  expect(
    needsCompaction([], {
      ...GENERATION_0_COMPACTION,
      contextBudgetTokens: GENERATION_0_COMPACTION.settings.reserveTokens,
    }),
    "the threshold is the budget less the reserve, so the budget must exceed the reserve",
  ).toBe(false);
  expect(estimateThreadTokens(conversation())).toBeGreaterThan(0);
});

test("a turn over the budget compacts through Pi and saves the compacted context", async () => {
  // Pi decides how many summarization calls one compaction costs — a second one when its cut point
  // falls inside a turn — so the script answers every summarization the same way and the turn's own
  // request is the last one the route saw.
  const script = scriptedStream([
    assistant([{ type: "text", text: SUMMARY }], "stop"),
    assistant([{ type: "text", text: SUMMARY }], "stop"),
    assistant([{ type: "text", text: "Continuing from the summary." }], "stop"),
  ]);

  const outcome = await runPiAgentTurn({
    prompt: "What did we decide?",
    state: { ...createPiAgentTurnState(model), messages: conversation() },
    env: makeFacetExecutionEnv().env,
    streamFn: script.streamFn,
    compaction: FORCED,
  });

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;

  // The summary came from Pi's own summarization call, not from a second summarizer written here.
  expect(script.contexts[0]?.systemPrompt ?? "").toContain("context summarization assistant");
  expect(outcome.state.messages[0]?.role).toBe("compactionSummary");
  expect(JSON.stringify(outcome.state.messages[0])).toContain("auth.ts");

  // The turn itself ran on the compacted context. Pi renders a compaction summary as a user
  // message carrying the summary text, which is why this facet hands Pi's own `convertToLlm` to
  // the agent: the agent's default conversion drops that role and the summary would never be sent.
  const turnContext = script.contexts.at(-1);
  expect(JSON.stringify(turnContext?.messages)).toContain("auth.ts");
  expect(turnContext?.systemPrompt ?? "").toContain("cf-stumble");
  expect(
    outcome.state.messages.length,
    "the compacted thread is shorter than the one that went in",
  ).toBeLessThan(conversation().length + 2);
});

test("a replacement facet continues from the saved compacted context, and a fresh state drops it", async () => {
  const workspace = makeFacetExecutionEnv();
  await workspace.env.writeFile("/workspace/notes.md", "written before compaction");
  const compacting = scriptedStream([
    assistant([{ type: "text", text: SUMMARY }], "stop"),
    assistant([{ type: "text", text: SUMMARY }], "stop"),
    assistant([{ type: "text", text: "Continuing." }], "stop"),
  ]);
  const compacted = await runPiAgentTurn({
    prompt: "What did we decide?",
    state: { ...createPiAgentTurnState(model), messages: conversation() },
    env: workspace.env,
    streamFn: compacting.streamFn,
    compaction: FORCED,
  });
  if (!compacted.ok) throw new Error("the compacting turn must complete");

  // A replacement generation: a new execution environment over the same workspace and a new route,
  // handed nothing but the saved state.
  const replacement = makeFacetExecutionEnv();
  const afterReplacement = scriptedStream([
    assistant([{ type: "text", text: "Still here." }], "stop"),
  ]);
  const continued = await runPiAgentTurn({
    prompt: "Remind me.",
    state: compacted.state,
    env: replacement.env,
    streamFn: afterReplacement.streamFn,
  });

  expect(continued.ok).toBe(true);
  expect(JSON.stringify(afterReplacement.contexts[0]?.messages)).toContain("auth.ts");

  // Starting fresh replaces the conversation and the compacted context with it, and touches no
  // file: the note written before compaction is still readable through the same workspace.
  const fresh = createPiAgentTurnState(model);
  expect(fresh.messages).toEqual([]);
  const note = await workspace.env.readTextFile("/workspace/notes.md");
  expect(note.ok && note.value).toBe("written before compaction");
});

test("a route that cannot summarize leaves the conversation intact instead of losing it", async () => {
  const script = scriptedStream([
    assistant([{ type: "text", text: "Carrying on uncompacted." }], "stop"),
  ]);
  let summarizationRefused = false;
  const streamFn: StreamFn = (routeModel, context, options) => {
    if (summarizationRefused) return script.streamFn(routeModel, context, options);
    summarizationRefused = true;
    return failedStream();
  };

  const outcome = await runPiAgentTurn({
    prompt: "Continue.",
    state: { ...createPiAgentTurnState(model), messages: conversation() },
    env: makeFacetExecutionEnv().env,
    streamFn,
    compaction: FORCED,
  });

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(summarizationRefused).toBe(true);
  expect(
    outcome.state.messages.map((message) => message.role),
    "a failed summary must not cost the thread the conversation it was summarizing",
  ).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
});
