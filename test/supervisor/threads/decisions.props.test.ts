import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import {
  decideAbandonTurn,
  decideFinishTurn,
  decideStartTurn,
} from "../../../src/supervisor/threads/decisions.js";
import { emptyThread, type ProjectThread } from "../../../src/supervisor/threads/index.js";
import { sampleProjectOne } from "../../project-fixtures.js";

// The turn lease is decided by pure functions over one thread row, so these state its two rules
// over generated clocks, revisions and lease ids. The workerd sibling decisions.test.ts fixes
// those values at one clock and two same-length lease ids; what a property adds is the space
// between its examples. A row that claims an active turn while naming no deadline reaches the
// `?? 0` default that no example covers, and a drawn pair of ids is as often one id and its own
// prefix as two unrelated strings, so the lease check is held to equality rather than to any
// comparison that happens to separate "lease-a" from "lease-b".

const projectId = sampleProjectOne.id;

const clock = gs.integers({ minValue: 1, maxValue: 2 ** 40 });

const revisions = gs.integers({ minValue: 0, maxValue: 2 ** 20 });

const leaseIds = gs.text({ alphabet: "ab", maxSize: 4 });

function thread(overrides: Partial<ProjectThread>): ProjectThread {
  return { ...emptyThread(projectId), ...overrides };
}

test("an active turn holds the thread until its deadline, and holds nothing without one", () => {
  hegel.test((tc) => {
    const revision = tc.draw(revisions);
    const expectedRevision = tc.draw(revisions);
    const now = tc.draw(clock);
    const deadline = tc.draw(clock);
    // A row that says a turn is active while naming no deadline is the case the deciders default
    // to zero, so it is drawn here rather than assumed away.
    const namesDeadline = tc.draw(gs.booleans());

    const current = namesDeadline
      ? thread({ revision, turnActive: true, turnDeadlineAt: deadline })
      : thread({ revision, turnActive: true });

    const decision = decideStartTurn(projectId, current, expectedRevision, now);

    if (namesDeadline && deadline > now) {
      expect(decision, "a live lease admits nobody, whatever revision the caller claims").toEqual({
        kind: "rejected",
        problem: { code: "turn-conflict", projectId, deadlineAt: deadline },
      });

      return;
    }

    expect(decision).toEqual(
      expectedRevision === revision
        ? { kind: "started", revision }
        : {
            kind: "rejected",
            problem: { code: "stale-revision", projectId, currentRevision: revision },
          },
    );
  });
});

test("only the lease the row holds can finish or abandon the turn it admitted", () => {
  hegel.test((tc) => {
    const held = tc.draw(leaseIds);
    const presented = tc.draw(leaseIds);
    const now = tc.draw(clock);

    const current = thread({
      revision: tc.draw(revisions),
      turnActive: true,
      turnDeadlineAt: now + 1,
    });

    const claim = { held, presented };

    const finish = decideFinishTurn(projectId, current, claim, now);
    const abandon = decideAbandonTurn(projectId, current, claim);

    if (presented === held) {
      expect(finish).toEqual({ kind: "finished", nextRevision: current.revision + 1 });
      expect(abandon).toEqual({ kind: "abandoned" });

      return;
    }

    const lost = { kind: "rejected", problem: { code: "turn-lease-lost", projectId } };
    expect(finish, "a lease the row does not hold cannot complete a replacement turn").toEqual(
      lost,
    );
    expect(abandon, "nor cancel it").toEqual(lost);
  });
});
