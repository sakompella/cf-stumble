import type * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  authorizationTransition,
  AuthorizationEvent,
  credentialTransition,
  CredentialEvent,
  GitHubAuthorization,
  GitHubCredential,
  type checkedStatus,
  type ReconnectReason,
  type Recorded,
} from "../../../src/supervisor/projects/github-connection-machine.js";

type Pending = typeof GitHubAuthorization.cases.pending.Type;

type Observed = Extract<CredentialEvent, { _tag: "Observed" }>;

type View =
  | Readonly<{ kind: "unchecked" }>
  | Readonly<{ kind: "disconnected"; at: number }>
  | Readonly<{ kind: "tooling-missing"; at: number }>
  | Readonly<{ kind: "connected"; at: number; recorded: Recorded }>
  | Readonly<{ kind: "reconnect-required"; at: number; reason: ReconnectReason }>;

export type Model = Readonly<{ recorded: Recorded | null; view: View; pending: Pending | null }>;

export type Step =
  | Readonly<{ credential: CredentialEvent }>
  | Readonly<{ authorization: AuthorizationEvent }>;

export type Snapshot = Readonly<{
  credential: GitHubCredential;
  authorization: GitHubAuthorization;
}>;

export const INITIAL: Model = { recorded: null, view: { kind: "unchecked" }, pending: null };

export const START: Snapshot = {
  credential: GitHubCredential.cases.unchecked.make({}),
  authorization: GitHubAuthorization.cases.idle.make({}),
};

const source = gs.sampledFrom(["device-authorization", "configured-token"] as const);

const answerState = gs.sampledFrom([
  "connected",
  "missing",
  "unusable",
  "tooling-missing",
] as const);

const login = gs
  .optional(gs.sampledFrom(["", "octocat", "hubot"]))
  .map((value) => value ?? undefined);

const codes = gs.sampledFrom(["code-a", "code-b", "code-c"]);

const small = gs.integers({ minValue: 0, maxValue: 12 });

const pending = gs.record({
  _tag: gs.just("pending" as const),
  deviceCode: codes,
  userCode: gs.sampledFrom(["WDJB-MJHT", "ABCD-EFGH"]),
  verificationUri: gs.sampledFrom([
    "https://github.com/login/device",
    "https://example.test/device",
  ]),
  expiresAt: small,
  intervalSeconds: gs.integers(),
});

const credentialEvent = gs.composite<CredentialEvent>((tc) => {
  const now = tc.draw(gs.integers());

  switch (tc.draw(gs.integers({ minValue: 0, maxValue: 2 }))) {
    case 0:
      return CredentialEvent.Observed({
        answer: { state: tc.draw(answerState), login: tc.draw(login) },
        installedBy: tc.draw(gs.optional(source)) ?? undefined,
        now,
      });
    case 1:
      return CredentialEvent.WorkspaceUnreachable({ now });
    default:
      return CredentialEvent.InstallRefused({
        reason: tc.draw(gs.sampledFrom(["credential-rejected", "workspace-unavailable"] as const)),
        now,
      });
  }
});

const authorizationEvent = gs.composite<AuthorizationEvent>((tc) => {
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: 2 }))) {
    case 0:
      return AuthorizationEvent.Started({ pending: tc.draw(pending) });
    case 1:
      return AuthorizationEvent.Elapsed({ now: tc.draw(small) });
    default:
      return AuthorizationEvent.Settled({ deviceCode: tc.draw(codes) });
  }
});

const steps = gs.arrays(
  gs.oneOf<Step>(
    credentialEvent.map((credential) => ({ credential })),
    authorizationEvent.map((authorization) => ({ authorization })),
  ),
  { maxSize: 14 },
);

function reconnect(reason: ReconnectReason, at: number): View {
  return { kind: "reconnect-required", at, reason };
}

function recordedByObserving(before: Recorded | null, event: Observed): Recorded {
  return {
    login: event.answer.login ?? before?.login ?? "",
    source: event.installedBy ?? before?.source ?? "device-authorization",
    connectedAt: event.installedBy === undefined ? (before?.connectedAt ?? 0) : event.now,
  };
}

function viewAfterAnswer(model: Model, event: Observed): View {
  const { answer, now } = event;

  if (answer.state === "connected") {
    return { kind: "connected", at: now, recorded: recordedByObserving(model.recorded, event) };
  }

  if (answer.state === "tooling-missing") return { kind: "tooling-missing", at: now };

  if (answer.state === "unusable") return reconnect("credential-rejected", now);

  return model.recorded === null
    ? { kind: "disconnected", at: now }
    : reconnect("credential-missing", now);
}

function viewAfter(model: Model, event: CredentialEvent): View {
  if (event._tag === "Observed") return viewAfterAnswer(model, event);

  return event._tag === "InstallRefused"
    ? reconnect(event.reason, event.now)
    : reconnect("workspace-unavailable", event.now);
}

function pendingAfter(current: Pending | null, event: AuthorizationEvent): Pending | null {
  if (event._tag === "Started") return event.pending;

  if (event._tag === "Elapsed") {
    return current !== null && current.expiresAt <= event.now ? null : current;
  }

  return current?.deviceCode === event.deviceCode ? null : current;
}

export function modelAfter(model: Model, taken: Step): Model {
  if ("authorization" in taken) {
    return { ...model, pending: pendingAfter(model.pending, taken.authorization) };
  }

  const view = viewAfter(model, taken.credential);

  return { ...model, recorded: view.kind === "connected" ? view.recorded : model.recorded, view };
}

export function credentialOf({ recorded, view }: Model): GitHubCredential {
  if (view.kind === "unchecked") return { _tag: "unchecked" };

  if (view.kind === "disconnected") return { _tag: "disconnected", checkedAt: view.at };

  if (view.kind === "tooling-missing") {
    return { _tag: "toolingMissing", checkedAt: view.at, recorded };
  }

  if (view.kind === "connected") return { _tag: "connected", checkedAt: view.at, ...view.recorded };

  return { _tag: "reconnectRequired", checkedAt: view.at, reason: view.reason, recorded };
}

export function authorizationOf({ pending: current }: Model): GitHubAuthorization {
  return current ?? { _tag: "idle" };
}

export function statusOf({ view }: Model): ReturnType<typeof checkedStatus> {
  if (view.kind === "tooling-missing") return { state: "tooling-missing" };

  if (view.kind === "connected") {
    return { state: "connected", login: view.recorded.login, source: view.recorded.source };
  }

  if (view.kind === "reconnect-required")
    return { state: "reconnect-required", reason: view.reason };

  return { state: "disconnected" };
}

function advance(snapshot: Snapshot, taken: Step): Snapshot {
  return "credential" in taken
    ? { ...snapshot, credential: credentialTransition(snapshot.credential, taken.credential) }
    : {
        ...snapshot,
        authorization: authorizationTransition(snapshot.authorization, taken.authorization),
      };
}

export function walk(
  tc: hegel.TestCase,
  inspect: (before: Snapshot, taken: Step, after: Snapshot) => void,
): void {
  let snapshot = START;

  for (const taken of tc.draw(steps)) {
    const after = advance(snapshot, taken);

    inspect(snapshot, taken, after);
    snapshot = after;
  }
}
