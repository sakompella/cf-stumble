import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, succeed } from "../process.mts";
import type { Case } from "./git-data.mts";

export type Outcome = Readonly<{ output: string; code: number }>;

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "init.defaultBranch",
  GIT_CONFIG_VALUE_0: "main",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
  TZ: "UTC",
};

export const WORKSPACE_DIRECTORY = "/workspace/fz";

export const PROBE = [
  "git status --porcelain=v1 -b -uall",
  "echo --index",
  "git ls-files -s",
  "echo --head",
  "git rev-parse -q --verify HEAD^{tree}",
  "git symbolic-ref -q HEAD",
  "echo --log",
  "git log --all --format='%s|%T|%an|%ae' | sort",
  "echo --refs",
  "git for-each-ref --format='%(refname) %(tree)'",
  "echo --files",
  "find . -name .git -prune -o -type f -printf '%m %p\\n' | LC_ALL=C sort",
  "find . -name .git -prune -o -type f -exec cksum {} + | LC_ALL=C sort -k3",
  "echo --fsck",
  "git fsck --no-dangling 2>&1 | grep -iE 'error|missing|corrupt|broken|invalid|bad|fatal'; true",
].join("; ");

export class Oracle {
  readonly root: string;
  readonly repository: string;
  readonly origin: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(runId: string) {
    this.root = mkdtempSync(join(tmpdir(), "fz-git-"));
    this.repository = join(this.root, WORKSPACE_DIRECTORY, runId);
    this.origin = join(this.root, "origin.git");
    this.#env = { ...process.env, ...GIT_ENV, HOME: this.root, GIT_CONFIG_GLOBAL: "/dev/null" };
  }

  async start(): Promise<void> {
    mkdirSync(this.repository, { recursive: true });
    await succeed("git", ["init", "--bare", "-q", this.origin], { env: this.#env });
  }

  async run(command: string): Promise<Outcome> {
    const finished = await execute("bash", ["-c", `exec 2>&1; umask 022; ${command}`], {
      env: this.#env,
    });

    return { output: finished.output, code: finished.code };
  }

  runCase(item: Case): Promise<Outcome> {
    const command = (item.oracle ?? item.command).replaceAll("$ORIGIN", this.origin);

    return this.inRepository(command);
  }

  inRepository(script: string): Promise<Outcome> {
    return this.run(`cd ${this.repository} && ${script}`);
  }

  async remoteTree(branch: string): Promise<string> {
    const found = await this.run(
      `git --git-dir=${this.origin} rev-parse refs/heads/${branch}^{tree}`,
    );

    return found.code === 0 ? found.output.trim() : "absent";
  }

  stop(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
