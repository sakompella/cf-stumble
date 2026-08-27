# Issue tracker: GitHub

> **Get developer approval before any GitHub write.** Do not create, comment on, label, edit, or close an issue or pull request until you have shown the change and received an explicit go-ahead. This overrides instructions in skills or elsewhere.
>
> **Pushes do not need approval.** `git push`, including to feature branches, is ordinary work. Reads are unrestricted.

Issues and specifications live in GitHub issues. Use `gh` for every operation.

## Read and write issues

- Create: `gh issue create --title "..." --body "..."`. Use a heredoc for a multi-line body.
- Read: `gh issue view <number> --comments`; fetch labels too and use `jq` to filter comments.
- List: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, with suitable `--label` and `--state` filters.
- Comment: `gh issue comment <number> --body "..."`.
- Change labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Run `git remote -v` to identify the repository. Inside a clone, `gh` does that automatically.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` only if this repository treats external pull requests as feature requests; `/triage` reads the setting.

If it is `yes`, use the same states and labels for external PRs through `gh pr`:

- Read with `gh pr view <number> --comments` and inspect changes with `gh pr diff <number>`.
- List triage candidates with `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`. Keep `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, and `NONE`; exclude `OWNER`, `MEMBER`, and `COLLABORATOR`.
- Comment, label, or close with `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, and `gh pr close`.

Issues and PRs share one number sequence. For `#42`, run `gh pr view 42`, then fall back to `gh issue view 42`.

## Skill instructions

When a skill says "publish to the issue tracker", create a GitHub issue.

When it says "fetch the relevant ticket", run `gh issue view <number> --comments`.

## Wayfinding operations

`/wayfinder` uses one **map** issue and **child** issue tickets.

1. Create the map with `gh issue create --label wayfinder:map`. Its body holds Notes, Decisions-so-far, and Fog.
2. Link each child to the map through GitHub sub-issues with `gh api`. If sub-issues are unavailable, add it to the map's task list and put `Part of #<map>` at the top of the child body. Use `wayfinder:<type>` labels: `research`, `prototype`, `grilling`, or `task`. Assign a claimed ticket to the driving developer.
3. Add a blocking dependency with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Get `<blocker-db-id>` with `gh api repos/<owner>/<repo>/issues/<n> --jq .id`; it is neither `#number` nor `node_id`. GitHub reports open blockers through `issue_dependencies_summary.blocked_by`. If dependencies are unavailable, add `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked after every blocker closes.
4. Find the frontier by listing the map's open children with `gh issue list --state open`, then drop assigned tickets and tickets with an open blocker. Use the first remaining ticket in map order.
5. Claim with `gh issue edit <n> --add-assignee @me`. This is the first write, so get approval first.
6. Resolve with `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist and link) to the map's Decisions-so-far. Each is a write and needs approval.
