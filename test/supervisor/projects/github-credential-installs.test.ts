import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";
import type { GitHubCredentialStatus } from "../../../src/github/index.js";
import { GitHubConnection, GitHubConnectionStore } from "../../../src/supervisor/projects/index.js";
import type {
  CredentialInstallResult,
  CredentialStatusResult,
  RepositoryAccessResult,
} from "../../../src/workspace/commands/index.js";
import { tick } from "../../eventually.js";

const NOW = 1_700_000_000_000;

const DEVICE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

const CONFIGURED_TOKEN = "ghp_cfstumbleFAKEconfiguredFAKEtoken012345";

const OWNERS = new Map([
  [DEVICE_TOKEN, "device-owner"],
  [CONFIGURED_TOKEN, "token-owner"],
]);

const OPERATIONS = ["repair", "authorize"] as const;

type Operation = (typeof OPERATIONS)[number];

type Call = Readonly<{ name: string; answer: () => GitHubCredentialStatus }>;

type Waiting = Call & Readonly<{ reply: (status: GitHubCredentialStatus) => void }>;

class ScheduledCredentialHost {
  held: string | null = null;
  calls = 0;
  readonly waiting: Waiting[] = [];

  installCredential(token: string): Promise<CredentialInstallResult> {
    return this.call(`install ${OWNERS.get(token) ?? token}`, () => {
      this.held = token;

      return this.status();
    }).then((status) => ({ ok: true, status }));
  }

  credentialStatus(): Promise<CredentialStatusResult> {
    return this.call("check", () => this.status()).then((status) => ({ ok: true, status }));
  }

  checkRepositoryAccess(): Promise<RepositoryAccessResult> {
    return Promise.reject(new Error("no repository check is expected"));
  }

  run(index: number): string {
    const [call] = this.waiting.splice(index, 1);

    if (call === undefined) throw new Error(`no host call at ${index}`);
    call.reply(call.answer());

    return call.name;
  }

  private call(
    name: string,
    answer: () => GitHubCredentialStatus,
  ): Promise<GitHubCredentialStatus> {
    this.calls += 1;

    return new Promise((reply) => {
      this.waiting.push({ name, answer, reply });
    });
  }

  private status(): GitHubCredentialStatus {
    const login = this.held === null ? undefined : OWNERS.get(this.held);

    return login === undefined ? { state: "missing" } : { state: "connected", login };
  }
}

function provider() {
  const replies = [
    {
      device_code: "device-code",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    },
    { access_token: DEVICE_TOKEN, token_type: "bearer" },
  ];

  return () => Promise.resolve(Response.json(replies.shift() ?? {}));
}

class Chooser {
  private path: number[] = [];
  private counts: number[] = [];

  readonly choose = (count: number): number => {
    const pick = this.path[this.counts.length] ?? 0;

    this.counts.push(count);

    return pick;
  };

  next(): boolean {
    const counts = this.counts;
    const path = counts.map((_, depth) => this.path[depth] ?? 0);

    this.counts = [];

    while (path.length > 0 && (path.at(-1) ?? 0) + 1 >= (counts[path.length - 1] ?? 0)) {
      path.pop();
    }

    if (path.length === 0) return false;

    path[path.length - 1] = (path.at(-1) ?? 0) + 1;
    this.path = path;

    return true;
  }
}

class Schedule {
  private readonly host = new ScheduledCredentialHost();
  private readonly github: GitHubConnection;
  private readonly unstarted: Operation[] = [...OPERATIONS];
  private readonly steps: string[] = [];
  private readonly started: Promise<void>[] = [];
  private settled = 0;
  private authorized: unknown;

  constructor(state: DurableObjectState) {
    const store = new GitHubConnectionStore(state.storage);

    store.clear();
    this.github = new GitHubConnection({
      store,
      workspaceName: "credential-installs",
      namespace: { getByName: () => this.host },
      environment: {
        clientId: "Iv1.cfstumbleFAKE",
        fallbackToken: CONFIGURED_TOKEN,
        fetcher: provider(),
      },
    });
  }

  async run(choose: (count: number) => number) {
    await Effect.runPromise(this.github.startAuthorization(NOW));

    for (let count = await this.choices(); count > 0; count = await this.choices()) {
      this.take(choose(count));
    }

    await Promise.all(this.started);

    return {
      steps: this.steps.join(", "),
      workspace: this.host.held === null ? null : OWNERS.get(this.host.held),
      record: this.github.lastKnown(NOW).github,
      authorized: this.authorized,
    };
  }

  private async choices(): Promise<number> {
    let seen = -1;

    while (seen !== this.host.calls + this.settled) {
      seen = this.host.calls + this.settled;

      for (let round = 0; round < 5; round += 1) await tick();
    }

    return this.unstarted.length + this.host.waiting.length;
  }

  private take(pick: number): void {
    const [operation] = this.unstarted.splice(pick, 1);

    if (operation === undefined) {
      this.steps.push(this.host.run(pick - this.unstarted.length));

      return;
    }

    this.steps.push(`start ${operation}`);
    this.started.push(
      operation === "repair"
        ? this.settle(this.github.ensureCredential(NOW).pipe(Effect.ignore))
        : this.settle(this.github.completeAuthorization(NOW)).then((outcome) => {
            this.authorized = outcome;
          }),
    );
  }

  private settle<T>(effect: Effect.Effect<T>): Promise<T> {
    return Effect.runPromise(effect).finally(() => {
      this.settled += 1;
    });
  }
}

afterEach(async () => {
  await reset();
});

test("whatever order the workspace runs a configured-token repair and the owner's device authorization in, the owner's credential stays in the workspace and the record and the answer name it", async () => {
  const owner = { state: "connected", login: "device-owner", source: "device-authorization" };

  const outcomes = await runInDurableObject(
    env.SUPERVISOR.getByName("credential-installs"),
    async (_instance, state) => {
      const chooser = new Chooser();
      const found = [await new Schedule(state).run(chooser.choose)];

      while (chooser.next()) found.push(await new Schedule(state).run(chooser.choose));

      return found;
    },
  );

  expect(outcomes.length).toBeGreaterThan(1);
  expect(outcomes).toEqual(
    outcomes.map(({ steps }) => ({
      steps,
      workspace: "device-owner",
      record: owner,
      authorized: { ok: true, status: owner, checkedAt: NOW },
    })),
  );
});
