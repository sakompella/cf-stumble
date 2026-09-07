# Design-question mining swarm

1. Frame. Find current owner preferences and contradictions for the seven questions in `.audit/design-questions.md`. Treat old wording as evidence, not authority.
2. Fan out. One worker mines the original Claude export. One worker mines the prior Pi session and current docs. Both report exact message or timestamp pointers.
3. Aggregate. Keep repeated preferences, mark reversals, and distinguish settled version 0 choices from later product questions.
4. Report. Update `.audit/design-questions.md` only when a source changes the current default, adds a missing option, or shows that a question is already answered.
