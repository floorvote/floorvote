# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Categories are issue types

What kind of work an issue is goes in its GitHub issue type, not a label. Every issue has exactly one. `/triage`'s two category roles map to types:

| Role in mattpocock/skills | Issue type | Use for                                                          |
| ------------------------- | ---------- | ---------------------------------------------------------------- |
| `bug`                     | Bug        | Something is broken: wrong behavior, wrong data, broken layout   |
| `enhancement`             | Feature    | New or changed behavior that members, admins, or operators see   |
| (none)                    | Research   | An investigation whose output is a finding, not code             |
| (none)                    | Task       | Maintenance with no visible change: renames, cleanup, CI, docs   |

Set a type with `gh issue create --type Bug` or `gh issue edit <number> --type Feature`, and filter with `gh issue list --type Research`. Don't create `bug`, `enhancement`, `research`, or `documentation` labels.

`user-facing`, `operator-facing`, and `security` stay labels, because they combine with any type and with each other.
