# Writing style

Write project documentation in plain technical English. The goal is clear, accurate prose that a developer can read without decoding compressed phrases or agent jargon. This guide is STE-inspired, not STE compliance. Do not impose the ASD-STE100 controlled dictionary, hard word counts, or hard sentence limits.

Name the actor and the action. Say who makes a decision, stores data, runs code, or checks a condition, then explain what happens. A sentence such as "the supervisor selects the active generation" gives the reader a responsible component and a concrete result. Passive voice is fine when the actor does not matter, but it should not hide an important one.

Use the terms in `docs/agents/CONTEXT.md` consistently when they name project concepts. The glossary distinguishes an ordinary commit, a labeled generation commit, and activation because they are different things. Do not invent a near-synonym merely to vary the prose. Ordinary words do not need a new project term.

Explain the mechanism and its consequence together when the connection matters. If a rule exists because a failure would be costly or confusing, say why. Complete the reasoning rather than leaving the reader to infer it:

> The supervisor writes the activation and live pointer in one transaction, so a crash cannot leave the system claiming that two different generations are live.

Sentence length should follow the idea, not a limit. A short sentence can state a fact plainly. A longer sentence can connect a condition, action, and result where separating them would hide the reasoning. Vary the rhythm naturally, but do not use variation as an excuse for vague language.

Use paragraphs for connected reasoning, trade-offs, and explanations that depend on one another. Use a numbered list for a procedure whose order matters. Use bullets or a table when readers need to compare independent facts. Do not turn an argument into bullets just because it contains several points, and do not bury a checklist in a dense paragraph.

Technical terms earn their place when they name a specific thing that readers need to distinguish, such as a Durable Object, a Git commit, or an activation ledger. Agent jargon usually names an impression instead of an operation. Prefer an ordinary explanation to abstract terms such as "surface", "shape", "seam", "ratchet", "load-bearing", or "provenance" when the ordinary explanation says more. For example, write "the API exposes these methods" rather than "the API surface" when discussing a small interface. Do not ban these words mechanically: use them when they have a defined literal meaning or are the established name of a project concept.

Avoid compressed constructions that leave the action implied. "Deployment is quality gated" forces the reader to infer who runs which checks and what happens on failure. Write the complete version instead:

| Compressed                               | Clearer                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Deployment is quality gated.             | The release pipeline runs the test suite before deployment and stops the deployment when a check fails.                  |
| The persistence seam is load-bearing.    | The supervisor owns the database transaction, so an agent change cannot alter the rule that selects the live generation. |
| The recovery path has strong provenance. | The recovery code comes from a pinned artifact that the active agent cannot modify.                                      |

Keep documents focused, but do not make them terse. State the facts, explain important consequences, and preserve meaningful uncertainty. A guide should help the next reader perform the work or understand a decision; it does not need to catalogue every writing rule.
