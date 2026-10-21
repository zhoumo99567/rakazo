# Groups and coordinated tasks

Chiefs can create groups through `create_group`. The creating Chief automatically joins and becomes the group's administrator. The owner still creates and manages groups through the UI. Every operation stays within the current user's Space.

Group administration is separate from the Bot's Chief/member role. Only the current group administrator can use `update_group`; transferring administration to an ordinary member does not grant Chief privileges. The owner can choose an administrator in group settings. The administrator must remain an active member, or be replaced in the same membership update. Existing approval cards remain required for Bot-driven group changes, and execution rechecks authorization after approval.

New Chief-created groups route unmentioned messages to the administrator. Explicit mentions and `@everyone` retain their targeting behavior. Existing groups and groups created manually without an administrator keep the first-member default until the owner assigns an administrator. An unavailable administrator never silently falls back to another member.

New group messages use the existing `coordination_v1` Task/Run protocol. `handoff_to_bot` creates a child task in the same group thread, restricted to current members. Progress, questions, cancellation, recovery and final results use the existing task inbox and parent-child relationships. Group history remains shared; private histories are not copied into it. Runs within a coordinated group share the existing thread execution lock, so model execution is serialized rather than simultaneous.

In a private owner-started task, `post_to_group` starts a child task in a group the calling Bot administers. The group task can delegate to members, and its final result returns to the original private task. Creation alone never starts work. A new independent group can receive its own task while another group's work is unfinished.

Changing administrators affects future message routing, not existing task ownership. Removing a member cancels that member's unfinished group task trees, including tasks waiting for children. Archiving a group cancels its unfinished tasks. Private work and unrelated group tasks are unaffected. Legacy runs already in flight keep their existing protocol.

Groups do not change Bot parentage, computer assignments, memory scopes or skill storage.

## Deployment

Deploy the migrations `20261021180000_group_administration` and `20261021190000_group_task_lookup` before restarting API and workers with this code:

```sh
pnpm --filter @rakazo/db generate
pnpm --filter @rakazo/db migrate
```

The group lookup migration indexes thread, protocol and status for cancellation. The administration migration adds nullable administrator/creator fields and a unique creation retry key. It does not assign administrators to old groups. Build the web client and restart services using the deployment's normal procedure. No production migration is performed by the implementation tests.

## Verification

The isolated PostgreSQL regression suite covers Chief-only creation, concurrent creation retries, admin transfer, same-group delegation, original-owner result recovery, private-to-group return, nonmember refusal, and cancellation of waiting task trees. Existing task coordination tests continue to cover reporting, live inbox delivery and delegation deduplication. Browser tests capture the administrator picker and its persisted selection; the mobile picker uses the existing native menu component.

Cancellation merges overlapping task subtrees into one batch and sends results only to surviving parents. The PostgreSQL suite exercises real thread claims, competing claimants, concurrent continuation recovery and recovery racing with group archive. Its 3,000-task regression asserts fewer than 80 SQL calls under the default transaction timeout. Run the database suites with `--no-file-parallelism` against an isolated database because recovery scans span all tasks.
