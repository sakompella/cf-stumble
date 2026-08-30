# Let the main facet own the mutable harness

> **Review:** Human-approved

A main-facet generation may replace all main-harness code, including its model loop, prompts, tools, policies, runtime, and use of files. The main and recovery harnesses both start from Pi-derived forks, but the recovery fork stays immutable, remains close to the Pi base, and omits the main harness's connector for requesting Supervisor capabilities. It stays outside every generation.

The mutable harness may submit a generation candidate or request activation or rollback of a specific generation. The supervisor checks and performs those requests; the facet cannot alter protected generation state or recovery code directly.
