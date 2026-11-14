import { workerName } from "../../infra/worker-settings.ts";
import {
  accountFrom,
  deployEnv,
  deployWithSecrets,
  destroyAndCheck,
  stageUrl,
} from "./cloudflare.mts";
import { reportModelCalls } from "./cost.mts";
import { GitHub } from "./github.mts";
import { Owner } from "./owner-api.mts";
import { execute } from "./process.mts";
import { forgetRestoreState, loadRestoreState, saveRestoreState } from "./restore-state.mts";
import { markerPath } from "./workflows.mts";

const MINUTE_MS = 60_000;

const METRICS_LAG_MS = 10 * MINUTE_MS;

export type TargetOptions = Readonly<{
  runId: string;
  url: string | undefined;
  stage: string | undefined;
  prefix?: string;
  password: string;
  env: NodeJS.ProcessEnv;
}>;

export class Target {
  readonly runId: string;
  readonly fresh: boolean;
  readonly stage: string | undefined;
  readonly github: GitHub;
  readonly #options: TargetOptions;
  readonly #startedMs = Date.now();
  #restoreLabel: number | undefined;
  #connectedProject: string | undefined;

  constructor(options: TargetOptions) {
    this.#options = options;
    this.runId = options.runId;

    const saved = loadRestoreState(options.runId);

    this.#restoreLabel = saved.label;
    this.#connectedProject = saved.project;
    this.fresh = options.url === undefined && options.stage === undefined;
    this.stage =
      options.stage ?? (this.fresh ? `${options.prefix ?? "e2e"}-${options.runId}` : undefined);
    this.github = new GitHub(options.env["GH_TOKEN"] ?? "");
  }

  async #owner(): Promise<Owner> {
    const { url, password, env } = this.#options;

    if (url !== undefined) return new Owner(url, password);

    if (this.stage === undefined) throw new Error("the target has neither a URL nor a stage");

    return new Owner(await stageUrl(accountFrom(env), this.stage), password);
  }

  async deploy(): Promise<Owner> {
    const { env, password } = this.#options;

    if (this.fresh && this.stage !== undefined) {
      await deployWithSecrets(this.stage, password, await deployEnv(env));
    }

    const owner = await this.#owner();

    await owner.waitHealthy(3 * MINUTE_MS);

    const active = (await owner.status()).generation;

    this.#restoreLabel = active?.label;
    this.#saveRestoreState();

    if (active === null || this.fresh) {
      await owner.control("activate", await owner.submit(await this.github.mainHead()));
    }

    return owner;
  }

  async checkOps(): Promise<void> {
    if (this.stage === undefined) return;

    const worker = workerName(this.stage);
    const minutes = Math.ceil((Date.now() - this.#startedMs + METRICS_LAG_MS) / MINUTE_MS) + 1;

    const checked = await execute(
      "pnpm",
      ["exec", "tsx", "tools/ops-check/run.mts", "--worker", worker, "--since", `${minutes}m`],
      { echo: true },
    );

    if (checked.code !== 0) throw new Error(`ops:check exited ${checked.code}`);

    await reportModelCalls(accountFrom(this.#options.env), worker, {
      fromMs: this.#startedMs,
      toMs: Date.now(),
    });
  }

  async #runBranches(): Promise<readonly string[]> {
    const marker = markerPath(this.runId, "-gen");
    const selfModify = await this.github.branches("self-modify/");

    const marked = await Promise.all(
      selfModify.map(async (branch) =>
        (await this.github.fileAt(marker, branch)) === undefined ? [] : [branch],
      ),
    );

    return [...(await this.github.branches(`e2e/${this.runId}`)), ...marked.flat()];
  }

  async deleteBranches(): Promise<void> {
    for (const branch of await this.#runBranches()) await this.github.deleteBranch(branch);

    const left = await this.#runBranches();

    if (left.length > 0) throw new Error(`branches left on GitHub: ${left.join(", ")}`);
  }

  get connectedProject(): string | undefined {
    return this.#connectedProject;
  }

  set connectedProject(projectId: string | undefined) {
    this.#connectedProject = projectId;
    this.#saveRestoreState();
  }

  #saveRestoreState(): void {
    saveRestoreState(this.runId, { label: this.#restoreLabel, project: this.#connectedProject });
  }

  async restore(): Promise<void> {
    const owner = await this.#owner();

    if (this.#connectedProject !== undefined) await owner.disconnect(this.#connectedProject);

    if (this.#restoreLabel !== undefined) await owner.control("rollback", this.#restoreLabel);

    forgetRestoreState(this.runId);
  }

  async destroy(): Promise<void> {
    if (this.stage === undefined) return;

    await destroyAndCheck(this.stage, await deployEnv(this.#options.env));
    forgetRestoreState(this.runId);
  }
}
