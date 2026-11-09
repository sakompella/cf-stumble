import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { logEvent } from "../diagnostics.js";
import {
  AccessStep,
  AccountEvent,
  decideAccess,
  refreshAccess,
  type ChatGPTAccount,
  type ConnectedAccount,
} from "./account.js";
import {
  authorizeUrl,
  exchangeFields,
  parseCallback,
  randomSecret,
  refreshFields,
  requestTokens,
  type ProviderFetch,
  type TokenFailure,
} from "./oauth.js";
import { decideRedemption, Redemption, SignInEvent } from "./sign-in.js";
import type { ChatGPTCredentialStore } from "./credential-store.js";
import {
  wireConnection,
  wireLogin,
  type ChatGPTAccess,
  type ChatGPTConnectionView,
  type ChatGPTLoginFailure,
  type ChatGPTLoginOutcome,
} from "./connection-view.js";

const LOGIN_TTL_MS = 10 * 60 * 1000;

type RefreshPhase = Data.TaggedEnum<{
  Idle: object;
  Refreshing: {
    readonly from: ConnectedAccount;
    readonly shared: Deferred.Deferred<ChatGPTAccount>;
  };
}>;

const RefreshPhase = Data.taggedEnum<RefreshPhase>();

function loginFailure(failure: TokenFailure): ChatGPTLoginFailure {
  switch (failure) {
    case "rate-limited":
    case "temporary":
      return "exchange-unavailable";
    case "missing-scope":
      return "missing-scope";
    case "ambiguous":
    case "rejected":
      return "exchange-refused";
    default: {
      const exhaustive: never = failure;

      return exhaustive;
    }
  }
}

function refreshRefusal(failure: TokenFailure, from: ConnectedAccount): AccountEvent | null {
  switch (failure) {
    case "rejected":
      return AccountEvent.RefreshRefused({
        accessToken: from.accessToken,
        reason: "refresh-refused",
      });
    case "missing-scope":
      return AccountEvent.RefreshRefused({
        accessToken: from.accessToken,
        reason: "missing-scope",
      });
    case "rate-limited":
    case "temporary":
    case "ambiguous":
      return null;
    default: {
      const exhaustive: never = failure;

      return exhaustive;
    }
  }
}

export type ChatGPTConnectionInput = Readonly<{
  store: ChatGPTCredentialStore;
  fetcher: ProviderFetch;
  model: string;
  clock: () => number;
}>;

export class ChatGPTConnection {
  private readonly store: ChatGPTCredentialStore;
  private readonly fetcher: ProviderFetch;
  private readonly model: string;
  private readonly clock: () => number;
  private phase: RefreshPhase = RefreshPhase.Idle();

  constructor(input: ChatGPTConnectionInput) {
    this.store = input.store;
    this.fetcher = input.fetcher;
    this.model = input.model;
    this.clock = input.clock;
  }

  view(): ChatGPTConnectionView {
    const now = this.clock();

    return {
      connection: wireConnection(this.store.account(), now),
      login: wireLogin(this.store.signIn(), now),
      model: this.model,
    };
  }

  startLogin(): Effect.Effect<ChatGPTConnectionView> {
    const state = randomSecret();
    const verifier = randomSecret();

    return authorizeUrl({ state, verifier, agentHostId: this.store.agentHostId() }).pipe(
      Effect.map((url) => {
        const now = this.clock();

        const attempt = {
          attemptId: crypto.randomUUID(),
          state,
          verifier,
          authorizeUrl: url,
          expiresAt: now + LOGIN_TTL_MS,
        };

        this.store.updateSignIn(SignInEvent.Started({ attempt }), now);

        return this.view();
      }),
    );
  }

  completeLogin(attemptId: string, callbackUrl: string): Effect.Effect<ChatGPTLoginOutcome> {
    return Effect.gen({ self: this }, function* () {
      const outcome = yield* this.redeem(attemptId, callbackUrl);

      logEvent(outcome.ok ? "info" : "warn", "chatgpt.login.complete", {
        outcome: outcome.ok ? "connected" : outcome.problem.code,
      });

      return outcome;
    });
  }

  disconnect(): ChatGPTConnectionView {
    this.store.updateSignIn(SignInEvent.Cancelled(), this.clock());

    return this.view();
  }

  access(rejected?: string): Effect.Effect<ChatGPTAccess> {
    return Effect.suspend(() =>
      RefreshPhase.$match(this.phase, {
        Refreshing: ({ from, shared }) => this.settled(Deferred.await(shared), from, rejected),
        Idle: () => {
          const now = this.clock();
          const account = this.store.update(AccountEvent.LimitLapsed({ now }), now);

          return AccessStep.$match(decideAccess(account, now, rejected), {
            Answer: ({ access }) => Effect.succeed(access),
            Refresh: ({ from }) => this.settled(this.refreshOnce(from), from, rejected),
          });
        },
      }),
    );
  }

  markRefused(accessToken: string): void {
    this.store.update(AccountEvent.ProviderRefused({ accessToken }), this.clock());
    logEvent("error", "chatgpt.provider-refused");
  }

  markUsageLimited(accessToken: string, limitedUntil: number | null): void {
    const now = this.clock();

    this.store.update(
      AccountEvent.LimitReported({ accessToken, reachedAt: now, limitedUntil }),
      now,
    );
  }

  private settled(
    refreshed: Effect.Effect<ChatGPTAccount>,
    from: ConnectedAccount,
    rejected: string | undefined,
  ): Effect.Effect<ChatGPTAccess> {
    return refreshed.pipe(
      Effect.map((after) => refreshAccess(after, from, this.clock(), rejected)),
    );
  }

  private redeem(attemptId: string, callbackUrl: string): Effect.Effect<ChatGPTLoginOutcome> {
    const refused = (code: ChatGPTLoginFailure) =>
      Effect.sync(() => ({ ok: false, problem: { code }, chatgpt: this.view() }) as const);

    return Effect.suspend(() => {
      const now = this.clock();

      return Redemption.$match(decideRedemption(this.store.signIn(), attemptId, now), {
        Unknown: () => refused("no-sign-in"),
        Expired: () => {
          this.store.updateSignIn(SignInEvent.Lapsed({ attemptId }), now);

          return refused("expired");
        },
        Redeem: ({ pending }) => {
          const callback = parseCallback(callbackUrl, pending.state);

          if (Result.isFailure(callback)) return refused(callback.failure);
          this.store.updateSignIn(SignInEvent.Redeemed({ attemptId }), now);

          return requestTokens(
            this.fetcher,
            exchangeFields(callback.success, pending.verifier),
          ).pipe(
            Effect.matchEffect({
              onFailure: ({ failure }) => {
                this.store.updateSignIn(SignInEvent.Failed({ attemptId }), this.clock());

                return refused(loginFailure(failure));
              },
              onSuccess: (grant): Effect.Effect<ChatGPTLoginOutcome> => {
                const exchangedAt = this.clock();

                const step = this.store.updateSignIn(
                  SignInEvent.Exchanged({
                    attemptId,
                    grant: {
                      accessToken: grant.accessToken,
                      refreshToken: grant.refreshToken,
                      expiresAt: exchangedAt + grant.expiresInMs,
                      clientId: callback.success.clientId,
                    },
                  }),
                  exchangedAt,
                );

                return step.account === null
                  ? refused("no-sign-in")
                  : Effect.sync(() => ({ ok: true, chatgpt: this.view() }) as const);
              },
            }),
          );
        },
      });
    });
  }

  private refreshOnce(from: ConnectedAccount): Effect.Effect<ChatGPTAccount> {
    const shared = Deferred.makeUnsafe<ChatGPTAccount>();
    this.phase = RefreshPhase.Refreshing({ from, shared });

    return requestTokens(this.fetcher, refreshFields(from.clientId, from.refreshToken)).pipe(
      Effect.match({
        onFailure: ({ failure }) => {
          logEvent(failure === "rejected" ? "error" : "warn", "chatgpt.refresh", {
            outcome: failure,
          });

          return refreshRefusal(failure, from);
        },
        onSuccess: (grant) =>
          AccountEvent.Refreshed({
            redeemed: from.refreshToken,
            grant: {
              accessToken: grant.accessToken,
              refreshToken: grant.refreshToken,
              expiresAt: this.clock() + grant.expiresInMs,
            },
          }),
      }),
      Effect.map((event) =>
        event === null ? this.store.account() : this.store.update(event, this.clock()),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          this.phase = RefreshPhase.Idle();
          Deferred.doneUnsafe(shared, exit);
        }),
      ),
      Effect.uninterruptible,
    );
  }
}
