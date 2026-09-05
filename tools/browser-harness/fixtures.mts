/**
 * The recorded answers the harness server gives, and the turn frames it streams.
 *
 * Every payload here copies the field names of the real route it stands in for, so a page that
 * reads a field the Supervisor does not send fails against this server too. The values are typed
 * as plain JSON rather than as the Supervisor's own types because those carry branded ids
 * (`ProjectId`, `HarnessCommit`, `GenerationLabel`) that only a parser can mint; a fixture that
 * asserted its way into a brand would prove nothing about the wire shape. The turn frames are the
 * exception: `ProjectTurnFrame` is plain data, so it is imported and the compiler holds the
 * harness to the real frame vocabulary.
 */

export const HARNESS_SCENARIOS = [
  "ready",
  "github-disconnected",
  "github-awaiting-authorization",
  "turn-failed",
  "save-failed",
  "stream-invalid",
  "cancelled",
  "timed-out",
  "turn-conflict",
  "no-active-generation",
] as const;

export type HarnessScenario = (typeof HARNESS_SCENARIOS)[number];

export function parseScenario(value: string | null | undefined): HarnessScenario | undefined {
  return HARNESS_SCENARIOS.find((scenario) => scenario === value);
}

export const HARNESS_PROJECT_ID = "octocat-hello-world";

const CONNECTED_GITHUB = {
  state: "connected",
  login: "octocat",
  source: "owner-authorization",
} as const;

function github(scenario: HarnessScenario) {
  if (scenario === "github-disconnected") {
    return { state: "disconnected" } as const;
  }
  if (scenario === "github-awaiting-authorization") {
    return {
      state: "awaiting-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
      expiresAt: 1_760_000_900_000,
      intervalSeconds: 5,
    } as const;
  }
  return CONNECTED_GITHUB;
}

export function projectsPayload(scenario: HarnessScenario) {
  return {
    ok: true,
    projects: [
      {
        id: HARNESS_PROJECT_ID,
        displayName: "hello-world",
        repositoryUrl: "https://github.com/octocat/hello-world",
        connectedAt: 1_759_000_000_000,
      },
      {
        id: "octocat-spoon-knife",
        displayName: "spoon-knife",
        repositoryUrl: "https://github.com/octocat/spoon-knife",
        connectedAt: 1_759_100_000_000,
      },
    ],
    github: github(scenario),
  };
}

export function statusPayload() {
  return {
    activeGeneration: {
      generation: { label: 1, harnessCommit: "abc123", status: "ready" },
      epoch: 3,
      activationId: "activation-3",
    },
    latestRecoveryReport: null,
  };
}

/**
 * The saved thread, built from the count the server is holding.
 *
 * The conversation is the string form the thread row holds — a JSON array of stored Pi messages —
 * and the first message names the project, so a check can tell one project's saved conversation
 * from another's instead of trusting that a re-render happened.
 */
export type ThreadState = Readonly<{ revision: number; messageCount: number }>;

export const INITIAL_THREAD: ThreadState = { revision: 3, messageCount: 2 };

function savedMessage(projectId: string, index: number) {
  const role = index % 2 === 0 ? "user" : "assistant";
  const text =
    index === 0
      ? `Read the README of ${projectId} and say what it is.`
      : role === "user"
        ? `Ask ${projectId} something else (message ${index + 1}).`
        : `Answer ${index + 1} about ${projectId}.`;
  return { role, content: [{ type: "text", text }] };
}

export function threadPayload(projectId: string, thread: ThreadState) {
  const messages = Array.from({ length: thread.messageCount }, (_unused, index) =>
    savedMessage(projectId, index),
  );
  return {
    ok: true,
    thread: {
      projectId,
      conversation: JSON.stringify(messages),
      messageCount: thread.messageCount,
      revision: thread.revision,
      turnActive: false,
      turnDeadlineAt: null,
    },
  };
}

export function submitPayload() {
  return {
    ok: true,
    outcome: {
      kind: "candidate-submitted",
      generation: { label: 2, harnessCommit: "def456", status: "ready" },
      epoch: 3,
    },
    preparation: {
      ok: true,
      report: {
        generation: { label: 2, harnessCommit: "def456", status: "ready" },
        effect: "recorded",
        stage: "ready",
        reason: "startup check answered",
        status: 200,
      },
    },
  };
}

export function controlPayload(kind: "activated" | "rolled-back", label: number) {
  return {
    ok: true,
    outcome: {
      kind,
      generation: {
        label,
        harnessCommit: kind === "activated" ? "def456" : "abc123",
        status: "ready",
      },
      epoch: 4,
      effect: "activated",
    },
  };
}

export function connectPayload(scenario: HarnessScenario) {
  return {
    ok: true,
    project: {
      id: "octocat-new-repo",
      displayName: "new-repo",
      repositoryUrl: "https://github.com/octocat/new-repo",
      connectedAt: 1_760_000_000_000,
    },
    alreadyConnected: false,
    github: github(scenario),
  };
}

export function authorizationPayload(scenario: HarnessScenario) {
  return { ok: true, github: github(scenario) };
}

export function recoveryPayload() {
  return { ok: true, report: null };
}
