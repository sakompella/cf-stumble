import {
  executeGitHubCredentialRequest,
  executeProjectProvisionRequest,
  type CommandOutput,
  type GitHubCredentialResult,
  type WorkspaceOperations,
  type WorkspacePathKind,
  type WorkspaceResult,
} from "../../../src/workspace/index.js";
import type { GitHubCredentialState } from "../../../src/github/index.js";

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
