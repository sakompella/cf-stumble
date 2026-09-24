# Let the main facet own the mutable harness

> **Review:** Human-approved

> **Amendment (2026-09-23):** Recovery-harness removal under handoff decision 7, owner-approved 2026-09-08.

A main-facet generation may replace all main-harness code, including its model loop, prompts, tools, policies, runtime, and use of files.

The mutable harness may submit a generation candidate or request activation or rollback of a specific generation. The supervisor checks and performs those requests; the facet cannot alter protected generation state directly.
