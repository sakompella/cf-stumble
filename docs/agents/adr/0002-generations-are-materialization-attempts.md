# Define a generation as a labeled harness commit

> **Review:** Human-approved

A generation is one specific, labeled Git commit in the harness repository. The Supervisor gives a selected harness commit its generation label, then records its preparation checks, activation, and recovery evidence against that generation. A failed check is an event on that labeled commit, not a different generation. Generation 0 is the first labeled mutable main-harness commit, not the immutable recovery harness.

Project commits always remain ordinary commits. A harness commit also remains ordinary until the Supervisor gives it a generation label. The checks required before a generation runs or becomes known good are separate decisions.
