# Deletion list: the legacy workspace execution path

T7 removed the hand-written buffered turn from the Generation 0 facet. That turn was the only
production caller of `WorkspaceHost.execute`, so the whole request-and-plan path behind that method
is now unreachable from `src/`. T7 does not delete it, because T6a owns `src/workspace/host.ts` in
the same wave. This file is the audited list T9 applies.

Every path named here was checked against the source at the T7 commit. Run the same checks again
before deleting: a task that lands between T7 and T9 may add a caller.

## What has no caller left

`WorkspaceHost.execute` (`src/workspace/host.ts`) answers a `WorkspaceRequest` with a
`WorkspaceResult`. Searching `src/` for a call of it returns nothing. The previous caller was
`executeToolPlan` in `src/facet/generation-0/tool-execution.ts`, which T7 deleted with the buffered
turn. Only tests reach it now.

Delete these together, or none of them. They are one path: a request parser, a planner, the
executor branches those plans reach, and the RPC method that ties them to the Durable Object.

| Path                                        | What to delete                                                                                     | Note                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workspace/host.ts`                     | the `execute` method and the `CONFIGURATION` constant it passes                                    | `CONFIGURATION` holds the fixed `check` command, which nothing else reads. `build`, `provision`, and `project` stay.                                                                                                                                                                                             |
| `src/workspace/decisions.ts`                | `parseWorkspaceRequest`, `planWorkspaceRequest`, `WorkspaceRequest`, `WorkspaceConfiguration`      | Keep `WorkspaceResult`, `WorkspaceFailure`, and `WorkspacePlan`: the build and provision paths return and plan with them.                                                                                                                                                                                        |
| `src/workspace/executor.ts`                 | `executeWorkspaceRequest`, and with it the only uses of the `list-files` and `git-diff` operations | Keep `executeHarnessBuildRequest`, `executeProjectProvisionRequest`, `WorkspaceOperations`, and `CommandOutput`.                                                                                                                                                                                                 |
| `src/workspace/index.ts`                    | the re-exports of every name above                                                                 |                                                                                                                                                                                                                                                                                                                  |
| `src/workspace/computer-operations.ts`      | the `listFiles` and `gitDiff` operations, once no plan asks for them                               | Check first: a later task may have given the project capability a reason to keep them.                                                                                                                                                                                                                           |
| `test/workspace/workspace-host.test.ts`     | the `execute` helper at line 71 and each test that uses it                                         | The surface assertion listing `["build", "constructor", "execute", "fetch", "project", "provision"]` must drop `execute`.                                                                                                                                                                                        |
| `test/supervisor/threads/fake-workspace.ts` | the whole file                                                                                     | T7 moved it here from the facet tests. Its only reader is `test/supervisor/threads/fresh-thread.test.ts`, which uses it to prove that starting a fresh thread makes no workspace call. Replace it with a fake of whatever surface that test should hold by then, rather than keeping a fake of a deleted method. |

## What must survive

The build and provisioning operations share the executor with the deleted path, so deleting the
whole module would break them.

- `WorkspaceHost.build` reaches `executeHarnessBuildRequest`. Its callers are
  `src/supervisor/artifacts/build-workspace.ts:58` and `:82`. This is how a labeled commit becomes a
  module map (ADR-0028).
- `WorkspaceHost.provision` reaches `executeProjectProvisionRequest`. Its caller is
  `src/workspace/provisioning.ts:81`. This clones a project and writes the managed instructions.
- `WorkspaceHost.project` returns the project capability one turn runs on. Its caller is
  `src/supervisor/projects/project-turn.ts:104`. This is the live path (ADR-0037, ADR-0039).
- `src/harness-build.ts` plans `read-file` and `run-command` steps, and `src/project-provision.ts`
  plans `run-command` and `write-file` steps. Those operation kinds stay even though the request
  parser that also produced them goes.

## What the facet no longer has

The diff the demo shows no longer comes from a `git_diff` tool. The Pi agent runs `git diff` with
its `bash` tool, and the turn publishes the output in a `tool-result` frame bounded by
`TOOL_RESULT_DISPLAY_MAX_BYTES` (`src/facet/generation-0/turn-policy.ts`).
`test/facet/generation-0/turn-diff.test.ts` runs that command through the real project RPC target.
So nothing in `src/facet/` needs the `git-diff` workspace operation, and deleting it costs the demo
nothing.
