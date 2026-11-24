# Triage labels

Skills name five triage roles. This repo uses the default label string for each.

| Role              | Label             | Meaning                                         |
| ----------------- | ----------------- | ----------------------------------------------- |
| `needs-triage`    | `needs-triage`    | A maintainer must evaluate the issue.           |
| `needs-info`      | `needs-info`      | Waiting for more information from the reporter. |
| `ready-for-agent` | `ready-for-agent` | Fully specified; an AFK agent can take it.      |
| `ready-for-human` | `ready-for-human` | A human must implement it.                      |
| `wontfix`         | `wontfix`         | The repo will not act on it.                    |

When a skill names a role, apply the label in the second column. For example, "apply the AFK-ready triage label" means `ready-for-agent`.
