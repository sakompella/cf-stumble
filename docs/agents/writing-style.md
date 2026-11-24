# Writing style

Write project docs in plain technical English: clear, accurate prose a developer reads without decoding. This is STE-inspired guidance, with no controlled dictionary and no hard word or sentence limits.

- **Name the actor and the action.** "The Supervisor selects the active generation" names who decides and what results. Use the passive only when the actor does not matter.
- **Use the glossary's terms.** When a word names a project concept, use the term from `docs/agents/CONTEXT.md` every time. An ordinary commit, a labeled generation commit and an activation are different things, and a synonym blurs them. Ordinary ideas need ordinary words, not new terms.
- **Give the reason with the rule.** When a rule exists because a failure would be costly or confusing, say what the failure is: "The Supervisor writes the activation and the live pointer in one transaction, so a crash cannot leave two generations claiming to be live."
- **Let the idea set the sentence length.** A short sentence states a fact. A longer one can tie a condition, an action and a result together when splitting them would hide the reasoning.
- **Pick the form that fits.** Paragraphs for connected reasoning and trade-offs, a numbered list for steps whose order matters, bullets or a table for independent facts.
- **Prefer literal words to impressions.** Words such as "surface", "shape", "seam", "ratchet", "load-bearing" and "provenance" often name a feeling instead of an operation. Write what happens: "the API exposes these methods". Keep such a word when it has a defined literal meaning or is a project term.
- **Write the whole action.** A compressed phrase makes the reader guess who does what:

| Compressed                               | Clearer                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Deployment is quality gated.             | The release pipeline runs the test suite before deployment and stops the deployment when a check fails.                  |
| The persistence seam is load-bearing.    | The Supervisor owns the database transaction, so an agent change cannot alter the rule that selects the live generation. |
| The recovery path has strong provenance. | The recovery code comes from a pinned artifact that the active agent cannot modify.                                      |

A doc should help the next reader do the work or understand a decision. State the facts, the consequences that matter, and any real uncertainty.
