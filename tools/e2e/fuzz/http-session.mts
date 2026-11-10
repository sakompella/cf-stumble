import type { Finding } from "./context.mts";
import { send, type Case, type Reply } from "./http-case.mts";
import type { Generator } from "./http-gen.mts";
import { check, type Environment } from "./http-oracle.mts";
import { normalizedPath } from "./http-routes.mts";
import { render, shrink } from "./http-shrink.mts";

const MAX_PER_KEY = 2;

const SHRINK_SENDS = 40;

const HEALTH_EVERY = 200;

const REPORT_EVERY_MS = 30_000;

const STATUS_CASE: Case = {
  method: "GET",
  path: "/api/status",
  headers: [["authorization", "Basic {valid}"]],
  body: undefined,
  credential: "valid",
};

const HEALTH_CASE: Case = {
  method: "GET",
  path: "/health",
  headers: [],
  body: undefined,
  credential: "invalid",
};

type Settings = Readonly<{
  area: string;
  url: string;
  password: string;
  environment: Environment;
  generator: Generator;
  deadlineMs: number;
  signal: AbortSignal;
  log: (line: string) => void;
}>;

export class Session {
  readonly findings: Finding[] = [];
  readonly #settings: Settings;
  readonly #seen = new Map<string, number>();
  readonly #statuses = new Map<number, number>();
  #sent = 0;
  #reportedAt = Date.now();

  constructor(settings: Settings) {
    this.#settings = settings;
  }

  get sent(): number {
    return this.#sent;
  }

  statuses(): string {
    return JSON.stringify(Object.fromEntries(this.#statuses));
  }

  async exchange(probe: Case): Promise<Reply> {
    const { url, password } = this.#settings;
    const first = await send(url, password, probe);

    return first.status === 0 ? send(url, password, probe) : first;
  }

  async record(probe: Case, reply: Reply): Promise<void> {
    const { environment, area, log } = this.#settings;

    for (const violation of check(probe, reply, environment)) {
      const path = normalizedPath(probe.path)
        .replaceAll(/[a-z0-9-]{12,}/gu, ":id")
        .slice(0, 40);

      const key = `${violation.oracle}|${probe.method}|${reply.status}|${path}`;
      const count = this.#seen.get(key) ?? 0;

      this.#seen.set(key, count + 1);

      if (count >= MAX_PER_KEY) continue;

      const reduced = await shrink(
        probe,
        async (candidate) =>
          check(candidate, await this.exchange(candidate), environment).some(
            (other) => other.oracle === violation.oracle,
          ),
        SHRINK_SENDS,
      );

      this.findings.push({
        area,
        oracle: violation.oracle,
        reproduction: render(reduced),
        detail: `${violation.detail}; original ${render(probe).slice(0, 400)}`,
      });
      log(`FINDING ${violation.oracle}: ${violation.detail.slice(0, 160)}`);
    }
  }

  async health(label: string): Promise<void> {
    const anonymous = await this.exchange(HEALTH_CASE);
    const owner = await this.exchange(STATUS_CASE);

    if (anonymous.status === 200 && owner.status === 200) return;

    this.findings.push({
      area: this.#settings.area,
      oracle: "worker-unhealthy",
      reproduction: `GET /health then GET /api/status after ${label}`,
      detail: `health ${anonymous.status}, status ${owner.status}: ${owner.body.slice(0, 160)}`,
    });
  }

  async lane(): Promise<void> {
    const { generator, deadlineMs, signal, log } = this.#settings;

    while (Date.now() < deadlineMs && !signal.aborted) {
      const probe = generator.next();
      const reply = await this.exchange(probe);

      this.#sent += 1;
      this.#statuses.set(reply.status, (this.#statuses.get(reply.status) ?? 0) + 1);
      await this.record(probe, reply);

      if (this.#sent % HEALTH_EVERY === 0) await this.health(`${this.#sent} cases`);

      if (Date.now() - this.#reportedAt > REPORT_EVERY_MS) {
        this.#reportedAt = Date.now();
        log(`${this.#sent} cases, ${this.findings.length} findings, statuses ${this.statuses()}`);
      }
    }
  }
}
