import {
  executeHarnessBuildRequest,
  executeProjectProvisionRequest,
  executeProjectRemovalRequest,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../../src/workspace/executor.js";
import {
  executeGitHubCredentialRequest,
  type GitHubCredentialResult,
} from "../../../src/workspace/github-credential.js";
import type { GitHubCredentialState } from "../../../src/github/index.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../../src/harness-build.js";
import type { WorkspaceResult } from "../../../src/workspace/decisions.js";

/** A command the fake has been told to hold open until the test answers it. */
export class HeldCommand {
  readonly fragment: string;
  /** Resolves once the held command has started. */
  readonly reached: Promise<void>;
  readonly exitCode: Promise<number>;
  private markReached: (() => void) | undefined;
  private answer: ((exitCode: number) => void) | undefined;

  constructor(fragment: string) {
    this.fragment = fragment;
    this.reached = new Promise((resolve) => {
      this.markReached = resolve;
    });
    this.exitCode = new Promise((resolve) => {
      this.answer = resolve;
    });
  }

  start(): void {
    this.markReached?.();
  }

  /** Answer the held command with this exit code. */
  release(exitCode = 0): void {
    this.answer?.(exitCode);
  }
}

/**
 * A stand-in for the tenant's Workspace Host that runs the real surfaces.
 *
 * Every request goes through the production parse, plan, and effect shells; only Computer itself is
 * replaced, by a fake shell that answers the four commands cf-stumble sends. That keeps the tests
 * honest about which requests are accepted and what text is run, and it records every write and
 * every command and every standard input so a test can prove where a token did and did not go.
 *
 * It cannot show that provisioning or `gh` works. No test in this repository runs a shell.
 */
export class FakeTenantWorkspace implements WorkspaceOperations {
  readonly commands: string[] = [];
  readonly writes: (readonly [string, string])[] = [];
  /** Every command that was given standard input, with what it was given. */
  readonly stdins: (readonly [string, string])[] = [];
  /** Each credential request as JSON, so a test can search everything that was sent. */
  readonly credentialRequests: string[] = [];
  readonly names: string[] = [];

  /** What `gh auth status` reports. Installing a token moves it to `connected`. */
  credentialState: GitHubCredentialState = "missing";
  login = "octocat";
  repositoryAccess: "granted" | "denied" = "granted";
  cloneExitCode = 0;
  unavailable = false;
  private readonly held: HeldCommand[] = [];

  /**
   * Hold the next command whose text contains `fragment` until the test releases it, so a test can
   * choose how two overlapping operations interleave.
   */
  holdNext(fragment: string): HeldCommand {
    const held = new HeldCommand(fragment);
    this.held.push(held);

    return held;
  }

  lstat(): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve("directory");
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("nothing in these tests reads a workspace file"));
  }

  writeFile(path: string, content: string): Promise<void> {
    this.writes.push([path, content]);

    return Promise.resolve();
  }

  runCommand(
    source: string,
    _cwd?: string,
    _timeoutMs?: number,
    stdin?: string,
  ): Promise<CommandOutput> {
    this.commands.push(source);

    if (stdin !== undefined) this.stdins.push([source, stdin]);

    const heldIndex = this.held.findIndex((command) => source.includes(command.fragment));
    const [held] = heldIndex >= 0 ? this.held.splice(heldIndex, 1) : [];

    if (held !== undefined) return this.heldOutput(held);

    if (source.includes("gh auth login")) {
      this.credentialState =
        this.credentialState === "tooling-missing" ? "tooling-missing" : "connected";

      return this.output(
        this.credentialState === "tooling-missing" ? "tooling-missing" : "installed",
      );
    }

    if (source.includes("gh auth status")) {
      return this.output(
        this.credentialState === "connected" ? `connected ${this.login}` : this.credentialState,
      );
    }

    if (source.includes("git ls-remote")) {
      return this.output(
        this.repositoryAccess === "granted" ? "granted" : "denied fatal: repository not found",
      );
    }

    return Promise.resolve({ stdout: "", stderr: "", exitCode: this.cloneExitCode });
  }

  private async heldOutput(command: HeldCommand): Promise<CommandOutput> {
    command.start();

    return { stdout: "", stderr: "", exitCode: await command.exitCode };
  }

  private output(stdout: string): Promise<CommandOutput> {
    return Promise.resolve({ stdout: `${stdout}\n`, stderr: "", exitCode: 0 });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the Workspace Host's RPC boundary.
  credential(request: unknown): Promise<GitHubCredentialResult> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    this.credentialRequests.push(JSON.stringify(request));

    return executeGitHubCredentialRequest({ operations: this, request });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the Workspace Host's RPC boundary.
  provision(request: unknown): Promise<WorkspaceResult> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    return executeProjectProvisionRequest({ operations: this, request });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the Workspace Host's RPC boundary.
  build(request: unknown): Promise<WorkspaceResult> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    return executeHarnessBuildRequest({
      configuration: HARNESS_BUILD_CONFIGURATION,
      operations: this,
      request,
    });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the Workspace Host's RPC boundary.
  removeProject(request: unknown): Promise<WorkspaceResult> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    return executeProjectRemovalRequest({ operations: this, request });
  }

  ensureManagedInstructions(): Promise<WorkspaceResult> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    return Promise.resolve({ ok: true, result: { kind: "written" } });
  }

  /** The namespace view the Supervisor holds. One tenant, so every name reaches this host. */
  get namespace() {
    return {
      getByName: (name: string) => {
        this.names.push(name);

        return this;
      },
    };
  }
}
