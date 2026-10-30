import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { logEvent } from "../diagnostics.js";
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
import type { ChatGPTCredentialStore, StoredConnection } from "./credential-store.js";
import type {
  ChatGPTAccess,
  ChatGPTConnectionStatus,
  ChatGPTConnectionView,
  ChatGPTLoginFailure,
  ChatGPTLoginOutcome,
  ChatGPTUsageLimit,
} from "./connection-view.js";

export const LOGIN_TTL_MS = 10 * 60 * 1000;

export const REFRESH_WINDOW_MS = 8 * 60 * 1000;

type ConnectedCredential = Extract<StoredConnection, { state: "connected" }>;

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

export type ChatGPTConnectionInput = Readonly<{
  store: ChatGPTCredentialStore;
  fetcher: ProviderFetch;
  model: string;
  clock: () => number;
}>;

/**
 * One Durable Object instance, so concurrent turns share one `refreshing` slot and a rotating
 * refresh token is redeemed once. Eviction can lose a rotated token; the owner then reconnects.
 */
export class ChatGPTConnection {
  private readonly store: ChatGPTCredentialStore;
  private readonly fetcher: ProviderFetch;
  private readonly model: string;
  private readonly clock: () => number;
  private refreshing: Deferred.Deferred<ChatGPTAccess> | undefined;
  private exchanging: string | undefined;

  constructor(input: ChatGPTConnectionInput) {
    this.store = input.store;
    this.fetcher = input.fetcher;
    this.model = input.model;
    this.clock = input.clock;
  }

  view(): ChatGPTConnectionView {
    const stored = this.store.connection();
    const login = this.store.login();

    const usageLimit = this.currentUsageLimit();

    const connection: ChatGPTConnectionStatus =
      stored === undefined
        ? { state: "disconnected" }
        : stored.state === "needs-reconnect"
          ? stored
          : usageLimit === undefined
            ? { state: "connected", expiresAt: stored.expiresAt }
            : { state: "connected", expiresAt: stored.expiresAt, usageLimit };

    return {
      connection,
      login:
        login === undefined || login.expiresAt <= this.clock()
          ? null
          : {
              attemptId: login.attemptId,
              authorizeUrl: login.authorizeUrl,
              expiresAt: login.expiresAt,
            },
      model: this.model,
    };
  }

  startLogin(): Effect.Effect<ChatGPTConnectionView> {
    const state = randomSecret();
    const verifier = randomSecret();

    return authorizeUrl({ state, verifier, agentHostId: this.store.agentHostId() }).pipe(
      Effect.map((url) => {
        this.exchanging = undefined;
        this.store.startLogin({
          attemptId: crypto.randomUUID(),
          state,
          verifier,
          authorizeUrl: url,
          expiresAt: this.clock() + LOGIN_TTL_MS,
        });

        return this.view();
      }),
    );
  }

  /**
   * An address that does not parse leaves the attempt in place; once the code is sent the attempt
   * is used up.
   */
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
    this.exchanging = undefined;
    this.store.disconnect();

    return this.view();
  }

  /** `rejected` is a token the provider refused with 401; it is refreshed only while still stored. */
  access(rejected?: string): Effect.Effect<ChatGPTAccess> {
    return Effect.suspend(() => {
      if (this.refreshing !== undefined) return Deferred.await(this.refreshing);

      const stored = this.store.connection();

      if (stored === undefined) return Effect.succeed({ kind: "not-connected" } as const);

      if (stored.state === "needs-reconnect") {
        return Effect.succeed({ kind: "reconnect-required" } as const);
      }

      const limitedUntil = this.currentUsageLimit()?.limitedUntil ?? null;

      if (limitedUntil !== null) {
        return Effect.succeed({ kind: "usage-limited", limitedUntil } as const);
      }

      this.store.clearUsageLimit();

      const expiresSoon = stored.expiresAt - this.clock() < REFRESH_WINDOW_MS;

      if (!expiresSoon && rejected !== stored.accessToken) {
        return Effect.succeed({ kind: "ready", accessToken: stored.accessToken } as const);
      }

      return this.refreshOnce(stored, rejected === stored.accessToken);
    });
  }

  markRefused(accessToken: string): void {
    this.store.markNeedsReconnect(accessToken, "provider-refused", this.clock());
    logEvent("error", "chatgpt.provider-refused");
  }

  markUsageLimited(accessToken: string, limitedUntil: number | null): void {
    this.store.markUsageLimited(accessToken, { reachedAt: this.clock(), limitedUntil });
  }

  private currentUsageLimit(): ChatGPTUsageLimit | undefined {
    const limit = this.store.usageLimit();

    if (limit === undefined || limit.limitedUntil === null) return limit;

    return limit.limitedUntil > this.clock() ? limit : undefined;
  }

  private redeem(attemptId: string, callbackUrl: string): Effect.Effect<ChatGPTLoginOutcome> {
    const refused = (code: ChatGPTLoginFailure) =>
      Effect.sync(() => ({ ok: false, problem: { code }, chatgpt: this.view() }) as const);

    return Effect.suspend(() => {
      const login = this.store.login();

      if (login?.attemptId !== attemptId) return refused("no-sign-in");

      if (login.expiresAt <= this.clock()) {
        this.store.clearLogin();

        return refused("expired");
      }

      const callback = parseCallback(callbackUrl, login.state);

      if (Result.isFailure(callback)) return refused(callback.failure);
      this.store.clearLogin();
      this.exchanging = attemptId;

      return requestTokens(this.fetcher, exchangeFields(callback.success, login.verifier)).pipe(
        Effect.matchEffect({
          onFailure: ({ failure }) => refused(loginFailure(failure)),
          onSuccess: (grant): Effect.Effect<ChatGPTLoginOutcome> => {
            if (this.exchanging !== attemptId) return refused("no-sign-in");
            this.exchanging = undefined;

            return Effect.sync(() => {
              this.store.connect(
                {
                  accessToken: grant.accessToken,
                  refreshToken: grant.refreshToken,
                  expiresAt: this.clock() + grant.expiresInMs,
                  clientId: callback.success.clientId,
                },
                this.clock(),
              );

              return { ok: true, chatgpt: this.view() } as const;
            });
          },
        }),
      );
    });
  }

  /**
   * Runs uninterruptibly so a cancelled turn cannot stop it between the provider rotating the
   * refresh token and this object storing it.
   */
  private refreshOnce(stored: ConnectedCredential, forced: boolean): Effect.Effect<ChatGPTAccess> {
    const shared = Deferred.makeUnsafe<ChatGPTAccess>();
    this.refreshing = shared;

    return this.refresh(stored, forced).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          this.refreshing = undefined;
          Deferred.doneUnsafe(shared, exit);
        }),
      ),
      Effect.uninterruptible,
    );
  }

  private refresh(stored: ConnectedCredential, forced: boolean): Effect.Effect<ChatGPTAccess> {
    return requestTokens(this.fetcher, refreshFields(stored.clientId, stored.refreshToken)).pipe(
      Effect.match({
        onFailure: ({ failure }): ChatGPTAccess => {
          logEvent(failure === "rejected" ? "error" : "warn", "chatgpt.refresh", {
            outcome: failure,
          });

          if (failure === "rejected" || failure === "missing-scope") {
            this.store.markNeedsReconnect(
              stored.accessToken,
              failure === "rejected" ? "refresh-refused" : "missing-scope",
              this.clock(),
            );

            return this.storedAccess();
          }

          const current = this.store.connection();

          if (current?.state !== "connected" || current.accessToken !== stored.accessToken) {
            return this.storedAccess();
          }

          return !forced && stored.expiresAt > this.clock()
            ? { kind: "ready", accessToken: stored.accessToken }
            : { kind: "unavailable" };
        },
        onSuccess: (grant): ChatGPTAccess => {
          const now = this.clock();

          const replaced = this.store.replaceRefreshed(
            stored.refreshToken,
            {
              accessToken: grant.accessToken,
              refreshToken: grant.refreshToken,
              expiresAt: now + grant.expiresInMs,
            },
            now,
          );

          return replaced ? { kind: "ready", accessToken: grant.accessToken } : this.storedAccess();
        },
      }),
    );
  }

  private storedAccess(): ChatGPTAccess {
    const stored = this.store.connection();

    if (stored === undefined) return { kind: "not-connected" };

    return stored.state === "connected"
      ? { kind: "ready", accessToken: stored.accessToken }
      : { kind: "reconnect-required" };
  }
}
