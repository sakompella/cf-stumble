import * as Schema from "effect/Schema";
import {
  ANSWERS,
  Submitted as SubmittedAnswer,
  SubmissionInterrupted,
} from "../../src/api/answers.ts";
import type { ReleaseOwner, Submitted } from "./release.mts";

const Refusal = Schema.Struct({ problem: Schema.optional(Schema.Struct({ code: Schema.String })) });

export type Answer = Readonly<{ status: number; text: string }>;

export type RequestBody = Readonly<Record<string, string | number | boolean>>;

export type ApiClient = Readonly<{
  get: (path: string) => Promise<Answer>;
  post: (path: string, body: RequestBody, timeoutMs?: number) => Promise<Answer>;
}>;

function decoded<S extends Schema.ConstraintDecoder<unknown>>(answer: Answer, schema: S) {
  const { status, text } = answer;

  if (status !== 200) throw new Error(`the API answered ${status}: ${text}`);

  return Schema.decodeSync(Schema.fromJsonString(schema))(text);
}

const decodeInterrupted = Schema.decodeUnknownOption(Schema.fromJsonString(SubmissionInterrupted));

function submission(answer: Answer): Submitted {
  const interrupted = decodeInterrupted(answer.text);

  if (answer.status === 503 && interrupted._tag === "Some") {
    const { error, recorded } = interrupted.value;

    return {
      kind: "interrupted",
      reason:
        recorded === undefined ? error.code : `${error.code}, label ${recorded.label} recorded`,
    };
  }

  const { outcome, preparation } = decoded(answer, SubmittedAnswer);

  if (preparation.ok && preparation.report.stage === "ready") {
    return { kind: "ready", label: outcome.generation.label };
  }

  if (!preparation.ok && preparation.problem.code === "build-workspace-unavailable") {
    return { kind: "interrupted", reason: preparation.problem.code };
  }

  return {
    kind: "failed",
    label: outcome.generation.label,
    reason: preparation.ok
      ? `${preparation.report.stage}: ${preparation.report.reason}`
      : preparation.problem.code,
  };
}

export function releaseOwner(client: ApiClient): ReleaseOwner {
  return {
    async active() {
      const { activeGeneration } = decoded(
        await client.get("/api/status"),
        ANSWERS["GET /api/status"],
      );

      return {
        harnessCommit: activeGeneration.generation?.harnessCommit,
        epoch: activeGeneration.epoch,
      };
    },
    async submit(harnessCommit, timeoutMs) {
      let answer: Answer;

      try {
        answer = await client.post("/api/generations/submit", { harnessCommit }, timeoutMs);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);

        return { kind: "interrupted", reason: `the request did not complete: ${message}` };
      }

      return submission(answer);
    },
    async activate(label, observedEpoch, force) {
      const { status, text } = await client.post("/api/generations/activate", {
        label,
        observedEpoch,
        force,
      });

      const refusal = Schema.decodeOption(Schema.fromJsonString(Refusal))(text);

      return {
        ok: status === 200,
        code: refusal._tag === "Some" ? refusal.value.problem?.code : undefined,
      };
    },
  };
}
