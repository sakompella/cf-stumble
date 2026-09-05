# Give each project one Pi thread in one shared Computer workspace

> **Review:** Human-approved

In version 0, a project is a GitHub repository that the user has connected to cf-stumble. The page
lists projects in a collapsible left sidebar. Opening a project selects its repository within the
shared Computer workspace and its current Pi thread.

Each project has one current Pi thread. Starting a fresh thread replaces both the Pi conversation
and its compacted context. It does not delete, reset, or reclone the project files. cf-stumble
may retain replaced thread records, but version 0 does not present parallel threads within one
project.

The selected project's thread supplies the conversation context for a turn. Sharing a filesystem
does not merge thread histories or automatically add another project's conversation to the prompt.
The agent may inspect another repository when the task requires it, just as it could on a normal
development machine.

Version 0 uses one Computer workspace for the owner's harness repository and all connected project
repositories. The workspace keeps each Git repository in its own directory. Selecting a project
sets the repository in which the main harness starts work, but it is not a security boundary: the
personal agent may reach another repository when the user's work requires it.

This layout shares one container lifecycle, development-tool installation, and local GitHub
credential. Separate Git repositories still keep project and harness history distinct. Version 0
accepts the risk that an agent with workspace access can read or change another repository; it does
not build capability isolation between one owner's projects.

The main facet reuses the vendored Pi core for streaming, tool execution, thread state, and
compaction. The hand-written bounded turn loop is scaffolding, not the version 0 harness.
