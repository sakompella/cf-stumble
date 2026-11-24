# Issue tracker: GitHub

Issues and specs live in GitHub issues on `sakompella/cf-stumble`. Use `gh`; inside the clone it finds the repo itself.

**Every write needs Aditya's explicit OK first.** Show the exact change before you create, comment on, label, edit, assign or close an issue or pull request. This overrides any skill. Reads need no approval.

## Commands

- Create: `gh issue create --title "..." --body "..."` (heredoc for a multi-line body).
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, with `--label` and `--state` filters as needed.
- Comment: `gh issue comment <number> --body "..."`.
- Labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

When a skill says "publish to the issue tracker", create an issue. When it says "fetch the relevant ticket", run `gh issue view <number> --comments`.

Issues and pull requests share one number sequence. For a bare `#42`, try `gh pr view 42`, then `gh issue view 42`.

## Pull requests as a triage surface

**PRs as a request surface: no.** `/triage` reads this flag. If it is ever `yes`, triage external pull requests with the same labels: list them with `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` and keep only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` and `NONE` authors.

## Wayfinding

`/wayfinder` uses one **map** issue with **child** issues as tickets. Each write below needs approval.

1. Map: `gh issue create --label wayfinder:map`, with a body of Notes, Decisions-so-far and Fog.
2. Child: link it to the map as a GitHub sub-issue with `gh api`. Label it `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or `wayfinder:task`. Without sub-issues, add it to the map's task list and start the child body with `Part of #<map>`.
3. Blocking: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where the id comes from `gh api repos/<owner>/<repo>/issues/<n> --jq .id` (not the `#number` or `node_id`). `issue_dependencies_summary.blocked_by` counts open blockers. Without dependencies, start the child body with `Blocked by: #<n>, #<n>`.
4. Frontier: the map's open children with no assignee and no open blocker; take the first in map order.
5. Claim: `gh issue edit <n> --add-assignee @me`.
6. Resolve: `gh issue comment <n> --body "<answer>"`, `gh issue close <n>`, then add a pointer (gist and link) to the map's Decisions-so-far.
