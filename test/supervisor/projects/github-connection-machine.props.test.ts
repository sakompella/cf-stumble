import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { parseGitHubToken } from "../../../src/github/device-flow.js";
import {
  awaitingStatus,
  checkedAtOf,
  checkedStatus,
  ensureCommand,
  GitHubAuthorization,
  GitHubCredential,
  isWorking,
  knownStatus,
  recordedOf,
} from "../../../src/supervisor/projects/github-connection-machine.js";
import {
  authorizationOf,
  credentialOf,
  INITIAL,
  modelAfter,
  START,
  statusOf,
  walk,
  type Model,
  type Snapshot,
} from "./github-connection-model.js";

const FALLBACK = parseGitHubToken("ghp_fallbackToken01");

test("the stored credential and authorization follow the documented model after every event", () => {
  hegel.test((tc) => {
    let model = INITIAL;

    walk(tc, (_before, taken, after) => {
      model = modelAfter(model, taken);

      expect(after.credential).toEqual(credentialOf(model));
      expect(after.authorization).toEqual(authorizationOf(model));
    });
  });
});

function expectStatuses(model: Model, { credential, authorization }: Snapshot): void {
  const { pending } = model;
  const known = knownStatus(credential, authorization);

  expect(checkedStatus(credential)).toEqual(statusOf(model));
  expect(awaitingStatus(authorization)).toEqual(pending === null ? null : known);

  if (pending === null) {
    expect(known).toEqual(model.view.kind === "unchecked" ? null : statusOf(model));

    return;
  }

  expect(known).toStrictEqual({
    state: "awaiting-authorization",
    verificationUri: pending.verificationUri,
    userCode: pending.userCode,
    expiresAt: pending.expiresAt,
  });
  expect(JSON.stringify(known)).not.toContain(pending.deviceCode);
}

test("the status the page reads shows a pending sign-in over the credential, and never the device code", () => {
  hegel.test((tc) => {
    let model = INITIAL;

    expectStatuses(model, START);

    walk(tc, (_before, taken, after) => {
      model = modelAfter(model, taken);
      expectStatuses(model, after);
    });
  });
});

test("a credential is working only right after a check found it, and repair reads the credential alone", () => {
  hegel.test((tc) => {
    const fallback = tc.draw(gs.sampledFrom([undefined, FALLBACK]));
    let model = INITIAL;

    walk(tc, (_before, taken, after) => {
      model = modelAfter(model, taken);

      const usable = model.view.kind === "connected" || model.view.kind === "tooling-missing";
      const command = ensureCommand(after.credential, fallback);

      if ("credential" in taken)
        expect(isWorking(after.credential)).toBe(model.view.kind === "connected");

      if (usable) expect(command).toEqual({ _tag: "Usable", credential: after.credential });
      else if (fallback === undefined) {
        expect(command).toEqual({ _tag: "Unrepairable", credential: after.credential });
      } else expect(command).toEqual({ _tag: "InstallConfigured", token: fallback });
    });
  });
});

test("a credential keeps what was recorded, and only an install moves the source and connected time", () => {
  hegel.test((tc) => {
    expect(checkedAtOf(START.credential)).toBeNull();
    expect(recordedOf(START.credential)).toBeNull();

    walk(tc, (before, taken, after) => {
      if (!("credential" in taken)) return;

      const { credential: event } = taken;
      const was = recordedOf(before.credential);
      const now = recordedOf(after.credential);

      expect(checkedAtOf(after.credential)).toBe(event.now);

      if (was !== null) expect(now).not.toBeNull();

      if (event._tag !== "Observed" || event.answer.state !== "connected") {
        expect(now).toEqual(was);

        return;
      }

      expect(now?.source).toBe(event.installedBy ?? was?.source ?? "device-authorization");
      expect(now?.connectedAt).toBe(
        event.installedBy === undefined ? (was?.connectedAt ?? 0) : event.now,
      );
    });
  });
});

test("a pending authorization is replaced by a newer one, survives other codes, and ends at its expiry or settlement", () => {
  hegel.test((tc) => {
    walk(tc, (before, taken, after) => {
      if (!("authorization" in taken)) return;

      const event = taken.authorization;
      const { authorization } = before;

      if (event._tag === "Started") {
        expect(after.authorization).toEqual(event.pending);
      } else if (authorization._tag === "idle") {
        expect(after.authorization).toBe(authorization);
      } else {
        const ended =
          event._tag === "Settled"
            ? authorization.deviceCode === event.deviceCode
            : authorization.expiresAt <= event.now;

        expect(after.authorization._tag).toBe(ended ? "idle" : "pending");
      }
    });
  });
});

test("every reachable credential and authorization is valid, and a damaged recording is not", () => {
  hegel.test((tc) => {
    const damage = tc.draw(gs.sampledFrom(["login", "source", "connectedAt"] as const));

    walk(tc, (_before, _taken, after) => {
      expect(Schema.is(GitHubCredential)(after.credential)).toBe(true);
      expect(Schema.is(GitHubAuthorization)(after.authorization)).toBe(true);

      const recorded = recordedOf(after.credential);

      if (recorded === null) return;

      const { [damage]: _removed, ...damaged } = recorded;

      expect(
        Schema.is(GitHubCredential)({ _tag: "toolingMissing", checkedAt: 0, recorded: damaged }),
      ).toBe(false);
    });
  });
});
