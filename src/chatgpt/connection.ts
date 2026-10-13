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
  type CallbackProblem,
  type ProviderFetch,
  type TokenFailure,
} from "./oauth.js";
import type {
  ChatGPTCredentialStore,
  ReconnectReason,
  StoredConnection,
} from "./credential-store.js";

/** How long a started sign-in can be finished. */
export const LOGIN_TTL_MS = 10 * 60 * 1000;

/** An access token with less than this left is refreshed before it is used. */
export const REFRESH_WINDOW_MS = 8 * 60 * 1000;

export type ChatGPTConnectionStatus =
  | Readonly<{ state: "disconnected" }>
  | Readonly<{ state: "connected"; expiresAt: number }>
  | Readonly<{ state: "needs-reconnect"; reason: ReconnectReason }>;

export type ChatGPTLoginView = Readonly<{
  attemptId: string;
  authorizeUrl: string;
  expiresAt: number;
}>;

/** What the owner API and the page see. It never carries a token, a verifier, or a code. */
export type ChatGPTConnectionView = Readonly<{
  connection: ChatGPTConnectionStatus;
  login: ChatGPTLoginView | null;
  model: string;
}>;

export type ChatGPTLoginFailure =
  | "no-sign-in"
  | "expired"
  | CallbackProblem
  | "exchange-refused"
  | "exchange-unavailable"
  | "missing-scope";

export type ChatGPTLoginOutcome =
  | Readonly<{ ok: true; chatgpt: ChatGPTConnectionView }>
  | Readonly<{
      ok: false;
      problem: Readonly<{ code: ChatGPTLoginFailure }>;
      chatgpt: ChatGPTConnectionView;
    }>;

/**
 * The credential the model route may use now. `unavailable` means the token server was busy or
 * unreachable while the stored token could not be used; the stored tokens are unchanged.
 */
export type ChatGPTAccess =
  | Readonly<{ kind: "ready"; accessToken: string }>
  | Readonly<{ kind: "not-connected" }>
  | Readonly<{ kind: "reconnect-required" }>
  | Readonly<{ kind: "unavailable" }>;

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
  /** The configured ChatGPT model, shown in the view so the owner can see what turns use. */
  model: string;
  clock: () => number;
}>;

/**
 * The owner's ChatGPT connection, held by the Supervisor (ADR-0047).
 *
 * The Supervisor is one Durable Object instance, so every caller of {@link access} meets the same
 * `refreshing` slot: concurrent turns share one refresh, and a rotating refresh token is redeemed
 * once. Eviction drops the slot, and a refresh cut off by eviction may have rotated the refresh
 * token at the provider without this object storing it; the next refresh is then refused and the
 * owner reconnects.
 */
export class ChatGPTConnection {
  private readonly store: ChatGPTCredentialStore;
  private readonly fetcher: ProviderFetch;
  private readonly model: string;
  private readonly clock: () => number;
  private refreshing: Deferred.Deferred<ChatGPTAccess> | undefined;

  constructor(input: ChatGPTConnectionInput) {
    this.store = input.store;
    this.fetcher = input.fetcher;
    this.model = input.model;
    this.clock = input.clock;
  }

  view(): ChatGPTConnectionView {
    const stored = this.store.connection();
    const login = this.store.login();

    const connection: ChatGPTConnectionStatus =
      stored === undefined
        ? { state: "disconnected" }
        : stored.state === "connected"
          ? { state: "connected", expiresAt: stored.expiresAt }
          : stored;

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

  /** Start a sign-in, replacing any earlier one. The verifier and state stay in storage. */
  startLogin(): Effect.Effect<ChatGPTConnectionView> {
    const state = randomSecret();
    const verifier = randomSecret();

    return authorizeUrl({ state, verifier, agentHostId: this.store.agentHostId() }).pipe(
      Effect.map((url) => {
        this.store.startLogin({
          attemptId: crypto.randomUUID(),
          state,
          verifier,
          authorizeUrl: url,
          expiresAt: this.clock() + LOGIN_TTL_MS,
        });
        logEvent("info", "chatgpt.login.start");

        return this.view();
      }),
    );
  }

  /**
   * Redeem the address the sign-in ended on. An address that does not parse leaves the attempt in
   * place, so the owner can paste again; once the code is sent, the attempt is used up whatever
   * the token endpoint answers.
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
    this.store.disconnect();
    logEvent("info", "chatgpt.disconnect");

    return this.view();
  }

  /**
   * The access token to send now. `rejected` is a token the provider just refused with 401: while
   * it is still the stored one, it is refreshed; when a newer one replaced it, that one is used.
   */
  access(rejected?: string): Effect.Effect<ChatGPTAccess> {
    return Effect.suspend(() => {
      if (this.refreshing !== undefined) return Deferred.await(this.refreshing);

      const stored = this.store.connection();

      if (stored === undefined) return Effect.succeed({ kind: "not-connected" } as const);

      if (stored.state === "needs-reconnect") {
        return Effect.succeed({ kind: "reconnect-required" } as const);
      }

      const expiresSoon = stored.expiresAt - this.clock() < REFRESH_WINDOW_MS;

      if (!expiresSoon && rejected !== stored.accessToken) {
        return Effect.succeed({ kind: "ready", accessToken: stored.accessToken } as const);
      }

      return this.refreshOnce(stored, rejected === stored.accessToken);
    });
  }

  /** The provider refused this token even after a refresh. */
  markRefused(accessToken: string): void {
    this.store.markNeedsReconnect(accessToken, "provider-refused", this.clock());
    logEvent("error", "chatgpt.provider-refused");
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

      return requestTokens(this.fetcher, exchangeFields(callback.success, login.verifier)).pipe(
        Effect.matchEffect({
          onFailure: ({ failure }) => refused(loginFailure(failure)),
          onSuccess: (grant) =>
            Effect.sync(() => {
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
            }),
        }),
      );
    });
  }

  /**
   * One refresh that every concurrent caller shares. It runs uninterruptibly, so a cancelled turn
   * cannot stop it between the provider rotating the refresh token and this object storing it.
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

          // The token server was busy, but a token it did not refuse still works until it expires.
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

          logEvent("info", "chatgpt.refresh", { outcome: replaced ? "refreshed" : "superseded" });

          return replaced ? { kind: "ready", accessToken: grant.accessToken } : this.storedAccess();
        },
      }),
    );
  }

  /** What the stored row allows now, after a refresh found it changed or refused. */
  private storedAccess(): ChatGPTAccess {
    const stored = this.store.connection();

    if (stored === undefined) return { kind: "not-connected" };

    return stored.state === "connected"
      ? { kind: "ready", accessToken: stored.accessToken }
      : { kind: "reconnect-required" };
  }
}
