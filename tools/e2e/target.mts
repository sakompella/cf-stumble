import { workerName } from "../../infra/worker-settings.ts";
import {
  accountFrom,
  deleteStageImages,
  deployEnv,
  deployStage,
  destroyStage,
  setSecret,
  stageLeftovers,
  stageUrl,
} from "./cloudflare.mts";
import { reportModelCalls } from "./cost.mts";
import { GitHub, HARNESS_REMOTE } from "./github.mts";
import { Owner } from "./owner-api.mts";
import { execute } from "./process.mts";
import { markerPath } from "./workflows.mts";

const MINUTE_MS = 60_000;

const METRICS_LAG_MS = 10 * MINUTE_MS;

export type TargetOptions = Readonly<{
  runId: string;
  url: string | undefined;
  stage: string | undefined;
  stagePrefix?: string;
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
  connectedProject: string | undefined;

  constructor(options: TargetOptions) {
    this.#options = options;
    this.runId = options.runId;
    this.fresh = options.url === undefined && options.stage === undefined;
    const prefix = options.stagePrefix ?? "e2e";

    this.stage = options.stage ?? (this.fresh ? `${prefix}-${options.runId}` : undefined);
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
      const tools = await deployEnv(env);

      await deployStage(this.stage, tools);

      for (const [name, value] of [
        ["HARNESS_REPOSITORY_URL", HARNESS_REMOTE],
        ["GH_TOKEN", env["GH_TOKEN"] ?? ""],
        ["OWNER_PASSWORD", password],
      ] as const) {
        await setSecret(this.stage, name, value, env);
      }

      await deployStage(this.stage, tools, ["--force"]);
    }

    const owner = await this.#owner();

    await owner.waitHealthy(3 * MINUTE_MS);

    const active = (await owner.status()).generation;

    this.#restoreLabel = active?.label;

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

  async deleteBranches(): Promise<void> {
    const marker = markerPath(this.runId, "-gen");
    const selfModify = await this.github.branches("self-modify/");

    const marked = await Promise.all(
      selfModify.map(async (branch) =>
        (await this.github.fileAt(marker, branch)) === undefined ? [] : [branch],
      ),
    );

    for (const branch of [...(await this.github.branches(`e2e/${this.runId}`)), ...marked.flat()]) {
      await this.github.deleteBranch(branch);
    }
  }

  async restore(): Promise<void> {
    const owner = await this.#owner();

    if (this.connectedProject !== undefined) await owner.disconnect(this.connectedProject);

    if (this.#restoreLabel !== undefined) await owner.control("rollback", this.#restoreLabel);
  }

  async destroy(): Promise<void> {
    const { env } = this.#options;

    if (this.stage === undefined) return;

    const tools = await deployEnv(env);

    await destroyStage(this.stage, tools);
    await deleteStageImages(this.stage, tools);

    const left = await stageLeftovers(accountFrom(env), this.stage, env);

    if (left.length > 0) throw new Error(`left on the account: ${left.join(", ")}`);
  }
}
