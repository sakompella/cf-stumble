# E12 — Turn credit is an HTTP-level fact today; goal criterion 6 needs a durability fact

Status: CONFIRMED by the root agent on merged main `d1f2412`. Scopes T9. Blocks goal criterion 6.
Verifies the review's coverage-map note on criterion 6.

## Current rule

`src/supervisor/eligibility.ts:139-141`:

```ts
function isCreditedTurn(attempt: RelayAttempt): attempt is CreditedAttempt {
  return attempt.outcome === "body-completed" && attempt.responseStatus < 400;
}
```

A turn earns credit purely from the HTTP outcome of a relay attempt. Nothing in the predicate knows
whether the thread was saved.

## What consumes it, and why that matters

`isCreditedTurn` is used at `eligibility.ts:108`, inside `GenerationEligibility`. Its job is
ADR-0031's: relay facts decide whether a generation is known-good. The pipeline is
`belongsToMostRecentEra` -> `isCreditedTurn` -> `creditedSpan`, then the policy thresholds
`minimumCreditedTurns` and `minimumObservationSpanMs`.

So the same predicate currently answers TWO different questions:
1. **Generation health** — did this generation serve enough good responses to be trusted? A
   relay/HTTP fact is the right evidence for that.
2. **Completed-real-turn credit** — goal criterion 6: "Success requires Pi terminal success and a
   committed thread save. A rejected, failed, truncated, cancelled, or unsaved turn earns no
   completed-real-turn credit." A durability fact is the right evidence for that, and the current
   predicate cannot express it.

## The trap for T9

The obvious fix — tighten `isCreditedTurn` to require a saved thread — would silently change
generation eligibility semantics, which ADR-0031 defines from relay facts. That risks making a
healthy generation ineligible because of a thread-save failure that says nothing about the harness.

T9 should ADD the durability requirement for turn credit without collapsing the two concepts.
Whether that is a second predicate, a distinct fact recorded at save time, or a joined record is a
design decision T9 owns — but the report must state which of the two questions each predicate
answers, so a later reader cannot confuse them again.

## Why this is reachable only through T9

E6: no HTTP route reaches `startProjectTurn`, `finishProjectTurn`, `abandonProjectTurn` or
`streamProjectTurn`. T5 (merged) made finish and abandon require the admitting lease, so the
durability half now HAS a fencing token to record against. Joining admission, streaming, saving and
credit is the unit the `streamProjectTurn` doc comment names as "the next unit's work". That is T9.
