# Triage labels

Skills use five canonical triage roles. This table maps them to the label strings in this repository.

| Label in mattpocock/skills | Label in our tracker | Meaning                                        |
| -------------------------- | -------------------- | ---------------------------------------------- |
| `needs-triage`             | `needs-triage`       | A maintainer must evaluate the issue.          |
| `needs-info`               | `needs-info`         | Wait for more information from the reporter.   |
| `ready-for-agent`          | `ready-for-agent`    | The issue is fully specified for an AFK agent. |
| `ready-for-human`          | `ready-for-human`    | A human must implement it.                     |
| `wontfix`                  | `wontfix`            | The repository will not act on it.             |

When a skill names a role, apply the matching label from the right-hand column. For example, "apply the AFK-ready triage label" means `ready-for-agent`.

Change the right-hand column when the repository's label vocabulary changes.
