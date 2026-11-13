import { setTimeout as sleep } from "node:timers/promises";
import * as Schema from "effect/Schema";
import { pageRows, queryEvents } from "../ops-check/telemetry.mts";
import type { JsonValue } from "../json.mts";
import { plainTextBindings, workerName } from "../../infra/worker-settings.ts";
import { accountFrom, type Account } from "./cloudflare.mts";
import type { ConversationEntry } from "./owner-api.mts";
import { Skip } from "./steps.mts";
import { HARNESS_PROJECT, type Run } from "./workflows.mts";

const MODEL_CALL_EVENT = "chatgpt.model-call";

const LOGS_LIMIT_MS = 5 * 60_000;

const LOGS_POLL_MS = 15_000;

const FILES = ["package.json", "AGENTS.md", "flake.nix"].map(
  (file) => `/workspace/harness/${file}`,
);

const PROMPT = [
  "Read these three files with the read tool, one tool call each, in this order:",
  ...FILES.map((file, index) => `${index + 1}. ${file}`),
  'Then reply with one line: the "name" field of package.json.',
].join("\n");

const AnsweredRow = Schema.Struct({
  source: Schema.Struct({
    event: Schema.Literal(MODEL_CALL_EVENT),
    outcome: Schema.Literal("ok"),
    model: Schema.String,
    promptTokens: Schema.Number,
    cachedTokens: Schema.Number,
    instructionsHash: Schema.optional(Schema.String),
    toolsHash: Schema.optional(Schema.String),
  }),
});

const Served = Schema.Struct({
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  diagnostics: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String }))),
});

export type AnsweredCall = (typeof AnsweredRow.Type)["source"];

export type Answer = Readonly<{ provider: string; model: string; fellBack: boolean }>;

type ChatGPTTarget = Readonly<{ account: Account; worker: string; model: string }>;

export function answeredCalls(response: JsonValue): readonly AnsweredCall[] {
  return pageRows(response)
    .rows.filter(Schema.is(AnsweredRow))
    .map((row) => row.source);
}

export function answersOf(entries: readonly ConversationEntry[]): readonly Answer[] {
  return entries.map((entry) => {
    const served = Schema.decodeUnknownSync(Served)(entry.model[0]);

    return {
      provider: served.provider ?? "none",
      model: served.model ?? "none",
      fellBack: served.diagnostics?.some(({ type }) => type === "provider-fallback") ?? false,
    };
  });
}

function fingerprintFindings(
  calls: readonly AnsweredCall[],
  name: "instructionsHash" | "toolsHash",
): readonly string[] {
  const values = new Set(calls.map((call) => call[name]));

  if (values.has(undefined)) return [`a ${MODEL_CALL_EVENT} event has no ${name}`];

  return values.size > 1 ? [`${name} changed within the turn: ${[...values].join(", ")}`] : [];
}

export function turnFindings(
  model: string,
  answers: readonly Answer[],
  calls: readonly AnsweredCall[],
): readonly string[] {
  return [
    ...(answers.length < 2 ? [`the turn made ${answers.length} model calls, not several`] : []),
    ...answers.flatMap((answer, index) => [
      ...(answer.provider === "chatgpt" && answer.model === model
        ? []
        : [
            `answer ${index + 1} came from ${answer.provider} ${answer.model}, not chatgpt ${model}`,
          ]),
      ...(answer.fellBack ? [`answer ${index + 1} has a provider-fallback diagnostic`] : []),
    ]),
    ...(calls.length < answers.length
      ? [
          `Workers Logs show ${calls.length} ${MODEL_CALL_EVENT} ok events for ${answers.length} answers`,
        ]
      : []),
    ...calls.flatMap((call) =>
      call.model === model ? [] : [`a ${MODEL_CALL_EVENT} event names ${call.model}`],
    ),
    ...fingerprintFindings(calls, "instructionsHash"),
    ...fingerprintFindings(calls, "toolsHash"),
  ];
}

export function cachedShare(calls: readonly AnsweredCall[]): string {
  const prompt = calls.reduce((sum, call) => sum + call.promptTokens, 0);
  const cached = calls.reduce((sum, call) => sum + call.cachedTokens, 0);

  return prompt === 0 ? "n/a" : `${((100 * cached) / prompt).toFixed(1)}% (${cached}/${prompt})`;
}

async function loggedCalls(
  target: ChatGPTTarget,
  fromMs: number,
  expected: number,
  signal: AbortSignal,
): Promise<readonly AnsweredCall[]> {
  const deadline = Date.now() + LOGS_LIMIT_MS;

  for (;;) {
    const { token, id } = target.account;

    const calls = answeredCalls(
      await queryEvents(token, id, target.worker, { fromMs, toMs: Date.now() }, MODEL_CALL_EVENT),
    );

    if (calls.length >= expected || Date.now() >= deadline) return calls;

    await sleep(LOGS_POLL_MS, undefined, { signal });
  }
}

async function chatgptTurn(run: Run, target: ChatGPTTarget): Promise<void> {
  const state = await run.owner.chatgptConnection();

  if (state !== "connected") {
    throw new Skip(`ChatGPT is ${state} on ${run.owner.url}; sign in once on its owner page`);
  }

  const seen = (await run.owner.entries(HARNESS_PROJECT)).at(0)?.id ?? 0;
  const fromMs = Date.now();

  await run.owner.send(HARNESS_PROJECT, PROMPT);

  const settled = await run.owner.waitSettled(HARNESS_PROJECT, run.signal);

  if (settled.failure !== undefined) throw new Error(`the run stopped: ${settled.failure}`);

  const answers = answersOf(
    (await run.owner.entries(HARNESS_PROJECT)).filter(
      (entry) => entry.id > seen && entry.kind === "pi.assistant",
    ),
  );

  const calls = await loggedCalls(target, fromMs, answers.length, run.signal);

  console.error(
    `e2e: chatgpt: ${answers.length} answers, ${calls.length} logged calls, cached ${cachedShare(calls)}`,
  );

  const findings = turnFindings(target.model, answers, calls);

  if (findings.length > 0) throw new Error(findings.join("; "));
}

export async function chatgptArea(run: Run, stage: string | undefined): Promise<void> {
  if (stage === undefined) throw new Skip("the ChatGPT area reads Workers Logs and needs --stage");

  await chatgptTurn(run, {
    account: accountFrom(process.env),
    worker: workerName(stage),
    model: plainTextBindings(stage).CHATGPT_MODEL,
  });
}
