# Give each project one Pi thread and one Computer workspace

> **Review:** Human-approved

In version 0, a project is a GitHub repository that the user has connected to cf-stumble. The page
lists projects in a collapsible left sidebar. Opening a project selects its repository, durable
Computer workspace, and current Pi thread.

Each project has one current Pi thread. Starting a fresh thread replaces both the Pi conversation
and its compacted context. It does not delete, reset, or reclone the project workspace. cf-stumble
may retain replaced thread records, but version 0 does not present parallel threads within one
project.

Each project receives a separate Computer workspace. File paths and commands therefore refer only
to the selected project, and one project's tools cannot reach another project's files through a
shared directory tree. The harness build workspace remains separate from every project workspace.

The main facet reuses the vendored Pi core for streaming, tool execution, thread state, and
compaction. The hand-written bounded turn loop is scaffolding, not the version 0 harness.
