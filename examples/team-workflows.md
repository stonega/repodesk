# Repository reports, reusable skills and work handoffs

Implemented locally, **2026-10-07**. Use a dedicated pilot bot/repository for live
acceptance. Automated checks use fake providers and never send these requests.

## Repository status and daily report

After connecting/selecting a repository, ask in private Telegram chat:

```text
example/project 当前有哪些 PR 等待审核？附链接和查询时间。
查看 example/project 的 Issue #42 当前状态。
每天上午 9 点，Asia/Taipei 时区，汇总 example/project 昨天合并的 PR，
再列出当前待审核 PR，发到这里。保留每项的 GitHub 链接。
```

Review the schedule's repository sources, destination, timezone, next occurrences
and budget, then approve it. In the panel, **Workflows → New/Edit → Repository
sources** selects up to six repositories. Editing needs a new approval.
Default merged-PR report windows cover the previous complete calendar days in the
schedule's timezone; daylight-saving days may have 23 or 25 hours. Explicit query
dates can narrow the window. Open-PR status is current at retrieval.

For a linked group, a workspace admin can request and approve a private repository
report for that group/topic. The preview explicitly says the metadata will be
shared with that audience. Ad-hoc private repository reads stay in private chat.
Repository selection/connection or actor permission changes block old grants;
review a fresh proposal after reconnecting. Linked GitHub users can use
`/github sync` to refresh their upstream permissions.

The App needs Issues/Pull requests read permissions for these reads. Existing
Apps may require an owner to approve permissions in GitHub. Reports cite item URLs
and retrieval time, follow bounded paging, and disclose incomplete coverage.
Requested reviewers are pending requests, not proof of approval or CI success.

## Save a conversation as a team skill

After a successful assistant investigation in the same chat:

```text
把刚才这次 Bug 排查流程保存为团队技能，叫“登录问题排查”。
保留输入要求、排查步骤、输出格式和一个去除私人信息的例子。
```

Review the full proposed instructions and requested tools, then approve the draft.
This creates a **disabled, unpublished** skill visible to workspace admins.
An admin opens **Skills**, reviews/edits it, clicks **Publish draft**, then enables it.
Teammates can subsequently ask to use the named skill. A new published version does
not replace the version already pinned to an existing schedule.

Only the requester's retained successful assistant runs are eligible; group sources
stay in the same topic. Failed/in-progress coding handoffs are not successful
procedure examples. Source changes/removal invalidate pending proposals and
unpublished drafts. Once an admin publishes the sanitized procedure, it has its own
instruction lifecycle and remains until edited/archived; source expiry is recorded
in its provenance. Workspace deletion removes both source and skill content.
**Test draft policy** checks configuration, not live model quality.

## Continue from a work handoff

```text
昨天做到哪里了？哪些任务等我回答，哪些 PR 等我审核？
汇总登录问题相关任务的最后确认阶段和下一步。
```

Private briefs cover the person's own retained assistant/coding tasks across
permitted conversations and personal discussion notes. Group briefs stay in the
current group/topic and require current coding access. They include recorded
questions, checkpoints, verification evidence and PR links when available.
They do not change tasks or assume that a PR has merged.

## Manual pilot acceptance

1. Compare an open-PR list, a numbered issue and a yesterday report with GitHub;
   check dates, links and pending reviewers. Test a repository with multiple pages.
2. Approve one private report and one admin-approved group report. Pause it,
   restart the worker and verify no duplicate occurrence or historical backfill.
3. Save a useful assistant procedure, approve its draft, publish/enable it as an
   admin and have a colleague reuse it. Check that unpublished private examples
   never appear in another person's chat.
4. Start a task that asks a product question; confirm the personal brief identifies
   the actual question and the group brief excludes other topics/private work.
5. Revoke repository access or remove an input after retrieval but before delivery;
   verify the queued answer is blocked. Review usefulness and cost with a capped
   model budget before widening the pilot.
