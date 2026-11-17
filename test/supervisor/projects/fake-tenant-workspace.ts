import * as Effect from "effect/Effect";
import type { GitHubCredentialStatus } from "../../../src/github/index.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../../src/harness-build.js";
import {
  checkGitHubRepositoryAccess,
  type CloneSizeVerdict,
  type CommandAnswer,
  type CredentialInstallResult,
  type CredentialStatusResult,
  ensureManagedInstructions,
  executeHarnessBuildDiscard,
  executeHarnessBuildOutput,
  executeHarnessBuildStep,
  executeProjectProvisionRequest,
  executeProjectRemovalRequest,
  type HarnessBuildStepRequest,
  type HarnessLineage,
  type HarnessLineageRequest,
  installGitHubCredential,
  type InstructionsWriteResult,
  type ModuleMapAnswer,
  type ProjectProvisionAnswer,
  type ProjectProvisionRequest,
  type ProjectRemovalRequest,
  readGitHubCredentialStatus,
  readHarnessLineage,
  type RepositoryAccessResult,
} from "../../../src/workspace/commands/index.js";
import { HARNESS_DIRECTORY } from "../../../src/workspace-layout.js";

import {
  workspaceEffects,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type PromiseOperations,
  type WorkspacePathKind,
} from "../../workspace/promise-operations.js";

export class HeldCommand {
  readonly fragment: string;
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

  release(exitCode = 0): void {
    this.answer?.(exitCode);
  }
}

type CredentialRequest = Readonly<{ method: string; token?: string; repositoryUrl?: string }>;

export class FakeTenantWorkspace implements PromiseOperations {
  readonly commands: string[] = [];
  readonly writes: (readonly [string, string])[] = [];
  readonly stdins: (readonly [string, string])[] = [];
  readonly credentialRequests: string[] = [];
  readonly provisionRequests: ProjectProvisionRequest[] = [];
  readonly names: string[] = [];

  credentialState: GitHubCredentialStatus["state"] | "unreachable" = "missing";
  login = "octocat";
  repositoryAccess: "granted" | "denied" = "granted";
  cloneExitCode = 0;
  cloneSizeVerdict: CloneSizeVerdict | undefined;
  lineageOutput = "contains unknown\nactive \ntarget ";
  cloneNeedsCredential = false;
  unavailable = false;
  private readonly held: HeldCommand[] = [];

  holdNext(fragment: string): HeldCommand {
    const held = new HeldCommand(fragment);
    this.held.push(held);

    return held;
  }

  private readonly durablePaths = new Map<string, WorkspacePathKind>();
  private readonly durableFiles = new Map<string, string>();

  commandSync: "complete" | "incomplete" = "complete";

  loseClone(): void {
    this.durablePaths.clear();
    this.durableFiles.clear();
  }

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve(this.durablePaths.get(path));
  }

  removeTree(path: string): Promise<void> {
    for (const known of this.durablePaths.keys()) {
      if (known === path || known.startsWith(`${path}/`)) {
        this.durablePaths.delete(known);
        this.durableFiles.delete(known);
      }
    }

    return Promise.resolve();
  }

  readFile(path: string): Promise<string> {
    const content = this.durableFiles.get(path);

    return content === undefined
      ? Promise.reject(new Error(`no durable file at ${path}`))
      : Promise.resolve(content);
  }

  writeFile(path: string, content: string): Promise<void> {
    this.writes.push([path, content]);

    return Promise.resolve();
  }

  async runCommand(
    source: string,
    _cwd?: string,
    _timeoutMs?: number,
    stdin?: string,
  ): Promise<CommandOutput> {
    this.commands.push(source);

    if (stdin !== undefined) this.stdins.push([source, stdin]);

    const heldIndex = this.held.findIndex((command) => source.includes(command.fragment));
    const [held] = heldIndex >= 0 ? this.held.splice(heldIndex, 1) : [];
    const output = held === undefined ? this.answer(source) : await this.heldOutput(held, source);

    if (output.exitCode === 0) this.persist(source);

    return output;
  }

  private persist(source: string): void {
    const cloned = /^repository='([^']+)'$/mu.exec(source)?.[1];
    const remote = /^expected_remote='([^']+)'$/mu.exec(source)?.[1];
    const removed = /^rm -rf -- '([^']+)'/mu.exec(source)?.[1];

    if (cloned === undefined && removed === undefined) return;

    if (this.commandSync === "incomplete") {
      throw new WorkspaceSyncIncomplete({ message: "fake post-command sync pending" });
    }

    if (cloned !== undefined && remote !== undefined) {
      this.durablePaths.set(cloned, "directory");
      this.durablePaths.set(`${cloned}/.git`, "directory");
      this.durablePaths.set(`${cloned}/.git/config`, "file");
      this.durableFiles.set(`${cloned}/.git/config`, `[remote "origin"]\n\turl = ${remote}\n`);
    }

    if (removed !== undefined) {
      for (const path of this.durablePaths.keys()) {
        if (path === removed || path.startsWith(`${removed}/`) || path.startsWith(`${removed}.`)) {
          this.durablePaths.delete(path);
          this.durableFiles.delete(path);
        }
      }
    }
  }

  private answer(source: string): CommandOutput {
    if (source.includes("gh auth login")) {
      this.credentialState =
        this.credentialState === "tooling-missing" ? "tooling-missing" : "connected";

      return this.output(
        this.credentialState === "tooling-missing" ? "tooling-missing" : `connected ${this.login}`,
      );
    }

    if (source.includes("gh auth token")) {
      return this.output(
        this.credentialState === "connected" ? `connected ${this.login}` : this.credentialState,
      );
    }

    if (source.includes("merge-base --is-ancestor")) return this.output(this.lineageOutput);

    if (source.includes("git ls-remote")) {
      return this.output(
        this.repositoryAccess === "granted" ? "granted" : "denied fatal: repository not found",
      );
    }

    const unauthorized = this.cloneNeedsCredential && this.credentialState !== "connected";

    if (!unauthorized && this.cloneSizeVerdict !== undefined) {
      return { stdout: `size-verdict=${this.cloneSizeVerdict}\n`, stderr: "", exitCode: 122 };
    }

    return { stdout: "", stderr: "", exitCode: unauthorized ? 128 : this.cloneExitCode };
  }

  private async heldOutput(command: HeldCommand, source: string): Promise<CommandOutput> {
    command.start();

    const exitCode = await command.exitCode;

    return source.includes("gh auth login")
      ? { ...this.answer(source), exitCode }
      : { stdout: "", stderr: "", exitCode };
  }

  private output(stdout: string): CommandOutput {
    return { stdout: `${stdout}\n`, stderr: "", exitCode: 0 };
  }

  provisionHarness(): Promise<CommandOutput> {
    this.durablePaths.set(HARNESS_DIRECTORY, "directory");

    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  installCredential(token: string): Promise<CredentialInstallResult> {
    return this.credentialRequest({ method: "installCredential", token }, () =>
      installGitHubCredential(
        { lenient: workspaceEffects(this), durable: workspaceEffects(this) },
        token,
      ),
    );
  }

  credentialStatus(): Promise<CredentialStatusResult> {
    return this.credentialRequest({ method: "credentialStatus" }, () =>
      readGitHubCredentialStatus(workspaceEffects(this)),
    );
  }

  checkRepositoryAccess(repositoryUrl: string): Promise<RepositoryAccessResult> {
    return this.credentialRequest({ method: "checkRepositoryAccess", repositoryUrl }, () =>
      checkGitHubRepositoryAccess(workspaceEffects(this), repositoryUrl),
    );
  }

  private credentialRequest<A>(
    request: CredentialRequest,
    run: () => Effect.Effect<A>,
  ): Promise<A> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    this.credentialRequests.push(JSON.stringify(request));

    return Effect.runPromise(run());
  }

  provision(request: ProjectProvisionRequest): Promise<ProjectProvisionAnswer> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    this.provisionRequests.push(request);

    return Effect.runPromise(
      executeProjectProvisionRequest({ operations: workspaceEffects(this), request }),
    );
  }

  build(request: HarnessBuildStepRequest): Promise<CommandAnswer> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    return Effect.runPromise(
      executeHarnessBuildStep({
        configuration: HARNESS_BUILD_CONFIGURATION,
        operations: workspaceEffects(this),
        request,
      }),
    );
  }

  buildOutput(harnessCommit: string): Promise<ModuleMapAnswer> {
    return Effect.runPromise(
      executeHarnessBuildOutput({
        configuration: HARNESS_BUILD_CONFIGURATION,
        operations: workspaceEffects(this),
        request: harnessCommit,
      }),
    );
  }

  discardBuild(harnessCommit: string): Promise<CommandAnswer> {
    return Effect.runPromise(
      executeHarnessBuildDiscard({
        configuration: HARNESS_BUILD_CONFIGURATION,
        operations: workspaceEffects(this),
        request: harnessCommit,
      }),
    );
  }

  lineage(request: HarnessLineageRequest): Promise<HarnessLineage> {
    return Effect.runPromise(readHarnessLineage(workspaceEffects(this), request));
  }

  removeProject(request: ProjectRemovalRequest): Promise<CommandAnswer> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    return Effect.runPromise(
      executeProjectRemovalRequest({ operations: workspaceEffects(this), request }),
    );
  }

  ensureManagedInstructions(): Promise<InstructionsWriteResult> {
    if (this.unavailable) {
      return Promise.reject(new Error("fake workspace host is unavailable"));
    }

    return Effect.runPromise(ensureManagedInstructions(workspaceEffects(this)));
  }

  get namespace() {
    return {
      getByName: (name: string) => {
        this.names.push(name);

        return this;
      },
    };
  }
}
