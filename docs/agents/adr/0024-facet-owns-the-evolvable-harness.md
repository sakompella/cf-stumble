# Let the main facet own the mutable harness

> **Review:** Human-approved

A main-facet generation may replace all main-harness code, including its model loop, prompts, tools, policies, runtime, and use of files. The recovery harness stays immutable and outside every generation.

The mutable harness may submit a generation candidate or request activation or rollback of a specific generation. The supervisor checks and performs those requests; the facet cannot alter protected generation state or recovery code directly.
