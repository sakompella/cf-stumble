import { newRequestId, parseRequestId } from "../../src/diagnostics.js";
import { afterEach, expect, test, vi } from "vitest";
import {
  executeGitHubCredentialRequest,
  readWorkspaceCredentialStatus,
  type CommandOutput,
  type CredentialWorkspaceHost,
  type GitHubCredentialRequest,
  type GitHubCredentialResult,
  type WorkspaceOperations,
} from "../../src/workspace/index.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

type Sortable = string | number | boolean | null | undefined;

const byText = (a: Sortable, b: Sortable): number => String(a).localeCompare(String(b));

const LOGIN = "octocat-private-login";

function operationsAnswering(run: () => Promise<CommandOutput>): WorkspaceOperations {
  return {
    lstat: () => Promise.resolve("file"),
    readFile: () => Promise.reject(new Error("the status read never reads a file")),
    writeFile: () => Promise.resolve(),
    runCommand: run,
  };
}

const connected = operationsAnswering(() =>
  Promise.resolve({ stdout: `connected ${LOGIN}\n`, stderr: "", exitCode: 0 }),
);

const statusRequest = { kind: "github-credential", step: "status" } as const;

test("a status read logs its timed outcome and command with the request id, and never the login", async () => {
  const events = capturedEvents();
  const requestId = newRequestId();

  await executeGitHubCredentialRequest({
    operations: connected,
    installOperations: connected,
    request: statusRequest,
    requestId,
  });

  expect(named(events(), "github-credential.status")).toEqual([
    expect.objectContaining({
      level: "info",
      requestId,
      outcome: "connected",
      timeout: false,
      timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
    }),
  ]);
  expect(named(events(), "workspace.command")).toEqual([
    expect.objectContaining({
      requestId,
      command: "github-credential.status",
      timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
      exitCode: 0,
    }),
  ]);
  expect(everythingLogged()).not.toContain(LOGIN);
});

test("a status read without a request id writes no requestId field", async () => {
  const events = capturedEvents();

  await executeGitHubCredentialRequest({
    operations: connected,
    installOperations: connected,
    request: statusRequest,
  });

  expect(named(events(), "github-credential.status").at(0)).not.toHaveProperty("requestId");
  expect(named(events(), "workspace.command").at(0)).not.toHaveProperty("requestId");
});

test("a status state other than connected is a warning", async () => {
  const events = capturedEvents();

  await executeGitHubCredentialRequest({
    operations: operationsAnswering(() =>
      Promise.resolve({ stdout: "missing\n", stderr: "", exitCode: 0 }),
    ),
    installOperations: connected,
    request: statusRequest,
  });

  expect(named(events(), "github-credential.status").at(0)).toMatchObject({
    level: "warn",
    outcome: "missing",
  });
});

test("a status read that throws is one error event and still the public unavailable answer", async () => {
  const events = capturedEvents();
  const requestId = newRequestId();

  const result = await executeGitHubCredentialRequest({
    operations: operationsAnswering(() => Promise.reject(new Error("command timed out"))),
    installOperations: connected,
    request: statusRequest,
    requestId,
  });

  expect(result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
  expect(named(events(), "github-credential.status")).toEqual([
    expect.objectContaining({ level: "error", requestId, outcome: "threw", timeout: true }),
  ]);
});

/** A Workspace Host that answers each status call after a delay and records the id it was sent. */
class RecordingHost implements CredentialWorkspaceHost {
  readonly received: (string | undefined)[] = [];

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the Workspace Host RPC boundary this test drives.
  credential(
    _request: GitHubCredentialRequest,
    requestId?: string,
  ): Promise<GitHubCredentialResult> {
    this.received.push(requestId);

    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: true,
          result: { kind: "credential-status", state: "connected", login: undefined },
        });
      }, 5);
    });
  }
}

test("overlapping status reads keep their own request ids on the rpc events and the host call", async () => {
  const events = capturedEvents();
  const host = new RecordingHost();
  const first = newRequestId();
  const second = newRequestId();

  const read = (requestId: typeof first) =>
    readWorkspaceCredentialStatus({
      workspaceName: "workspace",
      namespace: { getByName: () => host },
      requestId,
    });

  await Promise.all([read(first), read(second)]);

  const rpc = named(events(), "workspace.rpc");
  expect(rpc.map((entry) => entry.requestId).toSorted(byText)).toEqual(
    [first, second].toSorted(byText),
  );
  expect(rpc.every((entry) => entry.timeoutMs === WORKSPACE_COMMAND_TIMEOUT_MS + 1_000)).toBe(true);
  expect(host.received.toSorted(byText)).toEqual([first, second].toSorted(byText));
});

test("a request id is always a fresh uuid, and only a uuid survives parsing", () => {
  const ids = Array.from({ length: 50 }, () => newRequestId());

  expect(new Set(ids).size).toBe(50);
  expect(ids.every((id) => parseRequestId(id) === id)).toBe(true);
  expect(parseRequestId("not-a-uuid\nevent=forged")).toBeUndefined();
  expect(parseRequestId(42)).toBeUndefined();
});
