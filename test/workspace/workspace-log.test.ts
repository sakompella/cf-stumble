import { afterEach, expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { capturedEvents, named } from "../log-capture.js";
import { sampleCatalog, sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { parseGitHubToken } from "../../src/github/index.js";
import {
  executeGitHubCredentialRequest,
  executeProjectProvisionRequest,
  installWorkspaceCredential,
  provisionProjectWorkspace,
  PROVISION_STALE_AFTER_MS,
  waitForWorkspaceProvision,
  type CommandOutput,
  type ProjectProvisionRequest,
  type ProvisionWorkspaceHost,
  type WorkspaceOperations,
  type WorkspacePathKind,
  type WorkspaceResult,
} from "../../src/workspace/index.js";

/**
 * Provisioning is where a wedged workspace used to go silent. These tests read the structured
 * events one provision leaves behind: every step with its duration and outcome, every wait on the
 * workspace exclusion with how it ended, and every command the Workspace Host ran with its exit
 * code. None of them may carry command text or output.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const PRIVATE_OUTPUT =
  "fatal: could not read from remote repository ghp_cfstumbleFAKEtoken0123456789";

/** A host whose clone exits with `cloneExit`, and which can be held before it answers. */
class ScriptedProvisionHost implements ProvisionWorkspaceHost {
  cloneExit = 0;
  #held: Promise<void> = Promise.resolve();
  release: () => void = () => {};

  hold(): void {
    this.#held = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
    await this.#held;

    return request.step === "instructions"
      ? { ok: true, result: { kind: "written" } }
      : {
          ok: true,
          result: { kind: "command", stdout: "", stderr: PRIVATE_OUTPUT, exitCode: this.cloneExit },
        };
  }
}

test("each provision step is logged with its duration and outcome, and never its output", async () => {
  const events = capturedEvents();
  const host = new ScriptedProvisionHost();
  host.cloneExit = 128;

  const provisioned = await provisionProjectWorkspace({
    workspaceName: tenantWorkspaceName("workspace-log-step"),
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace: namespaceFor(host),
  });

  expect(provisioned.isErr()).toBe(true);
  const steps = named(events(), "workspace.provision-step");
  expect(steps).toEqual([
    expect.objectContaining({
      level: "warn",
      plan: "project",
      projectId: sampleProjectOne.id,
      step: "clone",
      method: "provision",
      outcome: "provision-step-failed",
      exitCode: 128,
    }),
  ]);
  expect(steps[0]?.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(events())).not.toContain("could not read");
});

test("a provision that waits on the workspace exclusion logs how long and how the wait ended", async () => {
  const events = capturedEvents();
  const host = new ScriptedProvisionHost();
  const workspaceName = tenantWorkspaceName("workspace-log-exclusion");
  host.hold();

  const first = provisionProjectWorkspace({
    workspaceName,
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace: namespaceFor(host),
  });

  const cancelled = new AbortController();
  const waiting = waitForWorkspaceProvision(workspaceName, cancelled.signal);
  const admitted = waitForWorkspaceProvision(workspaceName);

  cancelled.abort();
  expect(await waiting).toBe(false);
  host.release();
  expect((await first).isOk()).toBe(true);
  expect(await admitted).toBe(true);

  const waits = named(events(), "workspace.exclusion-wait");
  expect(waits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ result: "aborted", waiter: "turn" }),
      expect.objectContaining({ result: "settled", waiter: "turn" }),
    ]),
  );
  expect(waits.every((wait) => Number(wait.waitedMs) >= 0)).toBe(true);
});

class CommandOperations implements WorkspaceOperations {
  lstat(): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve("directory");
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("not read"));
  }

  writeFile(): Promise<void> {
    return Promise.resolve();
  }

  runCommand(): Promise<CommandOutput> {
    return Promise.resolve({ stdout: PRIVATE_OUTPUT, stderr: PRIVATE_OUTPUT, exitCode: 3 });
  }
}

test("the Workspace Host logs a planned command by name and exit code, never its text or output", async () => {
  const events = capturedEvents();

  await executeProjectProvisionRequest({
    operations: new CommandOperations(),
    request: {
      kind: "provision-project",
      projectId: sampleProjectOne.id,
      repositoryUrl: sampleProjectOne.repositoryUrl,
      step: "clone",
    },
  });

  const commands = named(events(), "workspace.command");
  expect(commands).toEqual([
    expect.objectContaining({ level: "warn", command: "provision-project.clone", exitCode: 3 }),
  ]);
  expect(commands[0]?.durationMs).toBeGreaterThanOrEqual(0);
  const written = JSON.stringify(events());
  expect(written).not.toContain("could not read");
  expect(written, "the command text names the repository").not.toContain("git");
});

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

test("the credential install command is logged by name, and its token reaches no log", async () => {
  const events = capturedEvents();

  const result = await executeGitHubCredentialRequest({
    operations: new CommandOperations(),
    request: { kind: "github-credential", step: "install", token: FAKE_TOKEN },
  });

  expect(result).toMatchObject({ ok: false, error: { code: "credential-command-failed" } });
  expect(named(events(), "workspace.command")).toEqual([
    expect.objectContaining({ command: "github-credential.install", exitCode: 3 }),
  ]);
  expect(JSON.stringify(events())).not.toContain(FAKE_TOKEN);
});

test("a credential RPC to the Workspace Host is logged with its method, step, and outcome", async () => {
  const events = capturedEvents();
  const token = parseGitHubToken(FAKE_TOKEN);

  if (token === undefined) throw new Error("the fake token must parse");

  const installed = await installWorkspaceCredential({
    workspaceName: tenantWorkspaceName("workspace-log-credential-rpc"),
    namespace: namespaceFor({
      credential: () => Promise.reject(new Error(`install failed for ${FAKE_TOKEN}`)),
    }),
    token,
  });

  expect(installed.isErr()).toBe(true);
  expect(named(events(), "workspace.rpc")).toEqual([
    expect.objectContaining({
      level: "error",
      method: "credential",
      step: "install",
      outcome: "threw",
    }),
  ]);
  const everything = vi.spyOn(console, "error").mock.calls.flat().map(String).join("\n");
  expect(everything, "the redacted cause is logged too").toContain("credential-access.install");
  expect(everything).not.toContain(FAKE_TOKEN);
});

test("a plan presumed lost is logged as a stale exclusion when a new plan replaces it", async () => {
  const events = capturedEvents();
  vi.useFakeTimers();
  const startedAt = Date.now();
  const lost = new ScriptedProvisionHost();
  lost.hold();
  const replacement = new ScriptedProvisionHost();
  const workspaceName = tenantWorkspaceName("workspace-log-stale");
  const input = { workspaceName, projectId: sampleProjectOne.id, catalog: sampleCatalog };

  try {
    void provisionProjectWorkspace({ ...input, namespace: namespaceFor(lost) });
    await Promise.resolve();
    vi.setSystemTime(startedAt + PROVISION_STALE_AFTER_MS + 1);

    expect(
      (await provisionProjectWorkspace({ ...input, namespace: namespaceFor(replacement) })).isOk(),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }

  const [stale] = named(events(), "workspace.exclusion-stale");
  expect(stale).toMatchObject({ level: "warn" });
  expect(Number(stale?.heldForMs)).toBeGreaterThan(PROVISION_STALE_AFTER_MS);
});
