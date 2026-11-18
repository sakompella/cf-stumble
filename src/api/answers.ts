import * as Schema from "effect/Schema";
import { BackendSetting, ContainerOutcome } from "../backend-setting.js";
import { RUN_BUDGET_MINUTES } from "../turn-budget.js";
import type { Endpoint } from "./endpoints.js";

const Generation = Schema.Struct({
  label: Schema.Number,
  harnessCommit: Schema.String,
  status: Schema.Literals(["candidate", "ready", "failed"]),
});

const StatusAnswer = Schema.Struct({
  activeGeneration: Schema.Struct({ generation: Schema.NullOr(Generation), epoch: Schema.Number }),
  mainAhead: Schema.NullOr(Schema.Number),
});

const BuildDiagnostics = Schema.Struct({
  stdoutTail: Schema.String,
  stderrTail: Schema.String,
  truncated: Schema.Boolean,
});

const PreparationProblem = Schema.Union([
  Schema.Struct({ code: Schema.Literal("unknown-generation"), label: Schema.Number }),
  Schema.Struct({
    code: Schema.Literals([
      "stored-module-map-absent",
      "corrupt-artifact",
      "artifact-read-failed",
      "artifact-write-failed",
      "build-workspace-unavailable",
      "build-output-missing",
    ]),
    harnessCommit: Schema.String,
  }),
  Schema.Struct({
    code: Schema.Literal("build-step-failed"),
    harnessCommit: Schema.String,
    step: Schema.String,
    exitCode: Schema.Number,
    diagnostics: BuildDiagnostics,
  }),
  Schema.Struct({
    code: Schema.Literal("build-output-invalid"),
    harnessCommit: Schema.String,
    reason: Schema.String,
  }),
]);

export const Preparation = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    report: Schema.Struct({
      stage: Schema.Literals([
        "ready",
        "mount-failed",
        "deadline-expired",
        "compatibility-mismatch",
        "conversation-failed",
      ]),
      reason: Schema.String,
      generation: Generation,
      effect: Schema.Literals(["recorded", "no-op"]),
    }),
  }),
  Schema.Struct({ ok: Schema.Literal(false), problem: PreparationProblem }),
]);

export const Submitted = Schema.Struct({
  ok: Schema.Literal(true),
  outcome: Schema.Struct({
    kind: Schema.Literal("candidate-submitted"),
    generation: Generation,
    epoch: Schema.Number,
  }),
  preparation: Preparation,
});

export const SubmissionInterrupted = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.Literal("infrastructure-interrupted") }),
  recorded: Schema.optionalKey(
    Schema.Struct({ label: Schema.Number, harnessCommit: Schema.String }),
  ),
});

const SubmitAnswer = Schema.Union([Submitted, SubmissionInterrupted]);

const ControlAnswer = Schema.Struct({
  ok: Schema.Literal(true),
  outcome: Schema.Struct({
    kind: Schema.Literals(["activated", "rolled-back"]),
    generation: Generation,
    epoch: Schema.Number,
    effect: Schema.Literals(["activated", "no-op"]),
    droppedCommit: Schema.optionalKey(Schema.String),
  }),
});

const Project = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  repositoryUrl: Schema.String,
});

const ProjectsAnswer = Schema.Struct({
  ok: Schema.Literal(true),
  projects: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("harness"),
        id: Schema.String,
        displayName: Schema.String,
      }),
      Schema.Struct({ kind: Schema.Literal("repository"), ...Project.fields }),
    ]),
  ),
});

const ConnectAnswer = Schema.Struct({
  ok: Schema.Literal(true),
  project: Project,
  alreadyConnected: Schema.Boolean,
});

const DisconnectAnswer = Schema.Struct({
  ok: Schema.Literal(true),
  projectId: Schema.String,
  workspace: Schema.Literals(["removed", "failed"]),
});

const Accepted = Schema.Struct({ ok: Schema.Literal(true) });

export const ConnectRequest = Schema.Struct({ repositoryUrl: Schema.String });

export const MessageRequest = Schema.Struct({
  content: Schema.String,
  requestId: Schema.String,
  budgetMinutes: Schema.optional(Schema.Literals(RUN_BUDGET_MINUTES)),
});

const GitHubStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("disconnected") }),
  Schema.Struct({ state: Schema.Literal("tooling-missing") }),
  Schema.Struct({
    state: Schema.Literal("connected"),
    login: Schema.String,
    source: Schema.Literals(["device-authorization", "configured-token"]),
  }),
  Schema.Struct({
    state: Schema.Literal("reconnect-required"),
    reason: Schema.Literals(["credential-missing", "credential-rejected"]),
  }),
  Schema.Struct({
    state: Schema.Literal("awaiting-authorization"),
    verificationUri: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.Number,
  }),
]);

const GitHubAnswer = Schema.Struct({
  ok: Schema.Literal(true),
  github: Schema.NullOr(GitHubStatus),
  checkedAt: Schema.NullOr(Schema.Number),
});

const ChatGPTView = Schema.Struct({
  connection: Schema.Union([
    Schema.Struct({ state: Schema.Literal("disconnected") }),
    Schema.Struct({
      state: Schema.Literal("connected"),
      expiresAt: Schema.Number,
      usageLimit: Schema.optionalKey(
        Schema.Struct({ reachedAt: Schema.Number, limitedUntil: Schema.NullOr(Schema.Number) }),
      ),
    }),
    Schema.Struct({
      state: Schema.Literal("needs-reconnect"),
      reason: Schema.Literals(["refresh-refused", "provider-refused", "missing-scope"]),
    }),
  ]),
  login: Schema.NullOr(
    Schema.Struct({
      attemptId: Schema.String,
      authorizeUrl: Schema.String,
      expiresAt: Schema.Number,
    }),
  ),
  model: Schema.String,
});

export type ChatGPTView = typeof ChatGPTView.Type;

const ChatGPTAnswer = Schema.Struct({ ok: Schema.Literal(true), chatgpt: ChatGPTView });

const LoginRefusal = Schema.Struct({
  ok: Schema.Literal(false),
  problem: Schema.Struct({
    code: Schema.Literals([
      "no-sign-in",
      "expired",
      "bad-address",
      "provider-refused",
      "wrong-sign-in",
      "missing-code",
      "missing-client",
      "exchange-refused",
      "exchange-unavailable",
      "missing-scope",
    ]),
  }),
  chatgpt: ChatGPTView,
});

const BackendAnswer = Schema.Struct({ ok: Schema.Literal(true), backend: BackendSetting });

const BackendChanged = Schema.Struct({
  ok: Schema.Literal(true),
  backend: BackendSetting,
  container: ContainerOutcome,
  startsOn: BackendSetting,
});

export const LoginCompletion = Schema.Struct({
  attemptId: Schema.String,
  callbackUrl: Schema.String,
});

export const BackendChange = Schema.Struct({ backend: BackendSetting });

export const ANSWERS = {
  "GET /api/projects": ProjectsAnswer,
  "POST /api/projects/connect": ConnectAnswer,
  "POST /api/projects/:projectId/disconnect": DisconnectAnswer,
  "POST /api/projects/:projectId/messages": Schema.Struct({
    ok: Schema.Literal(true),
    submissionId: Schema.Number,
  }),
  "POST /api/projects/:projectId/abort": Accepted,
  "POST /api/projects/:projectId/thread/fresh": Schema.Struct({
    ok: Schema.Literal(true),
    conversationId: Schema.String,
  }),
  "GET /api/status": StatusAnswer,
  "POST /api/generations/submit": SubmitAnswer,
  "POST /api/generations/activate": ControlAnswer,
  "POST /api/generations/rollback": ControlAnswer,
  "GET /api/github/connection": GitHubAnswer,
  "POST /api/github/connection/refresh": GitHubAnswer,
  "POST /api/github/authorization": GitHubAnswer,
  "POST /api/github/authorization/complete": GitHubAnswer,
  "GET /api/chatgpt/connection": ChatGPTAnswer,
  "POST /api/chatgpt/login": ChatGPTAnswer,
  "POST /api/chatgpt/login/complete": Schema.Union([ChatGPTAnswer, LoginRefusal]),
  "POST /api/chatgpt/disconnect": ChatGPTAnswer,
  "POST /api/workspace/reset": Schema.Struct({
    ok: Schema.Literal(true),
    reset: Schema.Literal("workspace"),
  }),
  "GET /api/workspace/backend": BackendAnswer,
  "POST /api/workspace/backend": BackendChanged,
} as const satisfies Readonly<
  Record<
    Exclude<
      Endpoint,
      "GET /api/projects/:projectId/events" | "GET /api/projects/:projectId/entries"
    >,
    Schema.Top
  >
>;

export type AnsweredEndpoint = keyof typeof ANSWERS;

export type AnswerOf<E extends AnsweredEndpoint> = (typeof ANSWERS)[E]["Type"];

export type SubmissionInterrupted = typeof SubmissionInterrupted.Type;
