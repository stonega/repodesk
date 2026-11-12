# 定时任务与报告

用定时任务定期执行文字描述的请求，例如提醒、聊天总结或仓库报告，并发送到指定位置。当前支持每日和每周重复，不支持任意 cron 表达式或持续监控所有事件。

定时任务不要求先创建或批准技能。**Skill** 可以留为 **No skill**；需要复用特定技能时再选择，执行会固定该技能的发布版本。没有选择技能的任务不会因其他技能停用而挂起。

定时不会增加工具或数据源。天气等实时信息仍需可用且获准的数据工具；缺少数据时，机器人应说明具体缺口，不能编造报告。访问权限、审批和预算仍然适用。

定时任务和手动触发的工作流统一使用团队设置中的单次运行与每月预算，没有独立的工作流预算。团队预算为 **None** 时不设对应上限，填写 **0** 时仅允许零成本请求。

## 创建定时总结

在已关联群中明确提出：

> 每周五 17:00 Asia/Taipei 总结这个群过去七天的讨论，按决策、阻塞、待办排列，发到本 Topic。

机器人会先比较当前聊天及 Topic 中已有的任务；私聊只比较你自己的任务。
目的、来源和时间安排相同的任务会提示已有任务及其状态，包括草稿、暂停或挂起的任务。
相似但有差异时，会先确认是否确实需要另建任务；确认重复建立后才会继续提出新提案。

When the recurrence, local time and timezone are clear, the bot creates an active
schedule immediately. No requester or administrator approval button is required.
The confirmation shows the schedule, destination and next execution times. Missing
essential details are clarified before creation.

To change an existing schedule, describe the change in the same conversation,
for example, “Change my daily weather report to include AQI; keep 08:00
Asia/Taipei.” The bot updates your existing workflow and confirms the replacement.
It keeps one schedule, retains version history and cancels queued output from the
old version. Editing a paused schedule keeps it paused. A stale version or a
change to another owner's schedule, chat or Topic is rejected. Use the panel or
the commands below to pause or delete a schedule.

## 定期 GitHub 报告

例如：

> 每天 09:00 Asia/Taipei 给我一份 example/app 的 PR 报告，列出待审查、已合并和阻塞项，附链接。

工作区需先 [连接 GitHub](github.md)。Reports pin their repository sources and destination. Publishing private-repository
reports to a group requires an active workspace owner/admin as the workflow owner
with access to those repositories. Private read access alone does not allow group
publication; there is no separate workflow approval step.

Repository reports keep working when an unrelated repository changes or becomes
unavailable. Changes to the report's selected repositories, the workspace GitHub
connection, owner membership or current permissions can still suspend it. Restoring
access does not automatically reactivate a suspended schedule. Recheck its current
sources before saving it again; cancelled occurrences are not replayed.

GitHub 元数据可以生成报告，但不表示可以持续访问任意网站或使用所有插件。Cloudflare 工具和自动长期记忆不用于这些定时运行。

## 在面板管理

Open **Workflows** to view, edit and pause existing schedules. Each card shows the
owner's Telegram name, username and ID when available. Create new
schedules by describing the request in Telegram; the web panel has no creation
action. Explicit Telegram requests activate immediately when the recurrence, time
and timezone are clear; no requester or administrator approval is required. In the
panel, **Edit → Save** applies the updated schedule immediately. If the saved
version changes before you save, reload and review before retrying.
Editing a paused schedule keeps it paused until you choose **Resume**.

Only the workflow owner can edit its definition, including in the web panel.
Link the panel account to that owner's Telegram identity to use **Edit**. An
administrator role does not grant permission to edit another person's workflow.
Other authorized administrators can inspect details and use their existing
lifecycle controls. Management actions are audited; active membership, linked
groups, repository access, skills and team budgets still apply.

Ask in Telegram using ordinary language:

```text
Show my schedules
Pause the daily recap
Resume the daily recap
Run the daily recap now
Delete the daily recap
```

Actions require permission for the selected workflow. Identify the schedule by
name; clarify which one when several match. Pausing stops future triggers.
Resuming a paused workflow differs from restoring revoked authorization.

## Adjust output

Reply to a report: “For this answer, use English and put blockers first”. This
changes the current answer only. To save a rule, reply: “For future reports, always
use English and put blockers first”. Review and approve the persistent correction.
Future runs use the new rule; existing runs keep their original version. Workflow
instructions are also managed in the panel.

## 时间、失败和恢复

Private scheduled answers, including private Topics, can include [interactive
widgets](widgets.md) when the Telegram widgets preset is enabled. Save the desired
format in the task; group answers use text.

Each scheduled or **Run now** invocation carries out the saved task once. It does
not treat earlier setup messages as a new request to create or edit a schedule.
Conversation history is read only when the task needs it, such as a chat recap;
weather and similar live-data tasks start from their saved instructions. Earlier
confirmations and chat requests cannot authorize another workflow or saved rule.

- 使用 IANA 时区，例如 `Asia/Taipei`，不要只写可能有歧义的“周五下午”。涉及夏令时时核对显示的执行时间。
- 延迟超过五分钟的计划会跳过，恢复服务后不会集中补发大量过期输出。
- 所有者失去资格、选用的技能被停用等情况会挂起相关工作，需要处理原因并重新批准。
- 模型成功与消息成功交付是两种状态。在 **Runs & delivery** 分别检查。
- Telegram 发送结果未知时，先确认群内是否已有消息，不会自动重复发送。

群总结能覆盖多少消息取决于 [群组收集设置](groups.md) 和保留期限；不能补读 Telegram 旧历史。预算失败或无人收到报告时，参阅 [排障指南](troubleshooting.md)。

## Formatted Telegram messages

Displayed text in incoming Telegram rich messages can start the same private
conversation as ordinary text. Paragraphs and readable formatted blocks become
bounded plain text. Quoted or forwarded commands remain reference material.
Hidden links, buttons and widget content do not grant permission or invoke actions.
Media embedded only inside a rich message is not imported as an attachment.
