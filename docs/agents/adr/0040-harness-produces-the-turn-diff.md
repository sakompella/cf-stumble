# The harness produces the turn's diff

> **Review:** Agent-only

A turn that changed a file ends by running the repository's own diff and publishing it as the
turn's frame. Generation 0 does this itself, after the model has stopped and before the terminal
frame, through the same project capability the turn's tools ran on.

The alternative was one sentence in the system prompt telling the model to run `git diff` when the
user asks what changed. That made the diff a hope about the model: the route is a small model at low
reasoning effort, which skips a clause of a long prompt as an ordinary event, and nothing else in
the harness would notice.

What the harness owns and what it does not:

- It owns the question. The diff runs whenever a turn used a tool that can change a file, whatever
  the model said or asked for.
- It does not own the answer. `git` reports what the repository holds, so the content is the
  repository's, and a working directory that is not a repository produces a stated reason rather
  than a silent empty diff.
- A file the turn created and never staged is not in `git diff HEAD`. Reporting untracked files
  would be a second command and a second frame, which this decision does not need.

The frame is bounded like a tool result, and the Supervisor proves and forwards it on the same
terms (ADR-0037): the browser receives the generation's diff as fields it has proven, never as an
unparsed line.
