# 群组与话题

将机器人关联到群组后，成员可以在群内提问、总结和安排定时报告。群组加入、消息可见性、收集许可与工作区成员权限分别管理。

## Link a group

1. Add your bot to the intended Telegram group.
2. In the admin panel, open **Groups & Members → Groups → New** and copy the complete command.
3. Send `/link@your_bot TOKEN` in that group within ten minutes, using an active
   workspace member account that is also a Telegram group administrator.
4. Wait for **Group linked**. The panel updates automatically while the dialog is
   open, or when you return to the page. Test `/ask@your_bot hi` in the group.

The workspace's deployment operator can generate the token without verifying a
personal Telegram identity. Workspace owner/admin panel accounts can also generate
it. A token links one group once; it does not grant membership or an admin role.
Invite the person sending it through **Groups & Members** first if needed.

Generating another command invalidates the previous one. The token also stops
working after expiry, bot replacement or loss of its issuer's permissions. Share
it only with the intended group administrator. Anonymous administrators and bot
senders cannot link groups. Each workspace supports one linked group; unlink it
in the panel before connecting a different group. Check and relink after a group
migration or bot removal.

The private `/linktoken` command remains available to verified workspace
owner/admin members who prefer the Telegram-only flow.

## 在群里提问

- `/ask@your_bot 请总结本话题的结论`
- `@your_bot 这个 PR 的主要变化是什么？`
- Reply 一条机器人消息继续讨论。

将 `your_bot` 替换为实际用户名。Telegram 隐私模式可能导致普通 @提及无法送达；优先使用带机器人用户名的命令或 Reply。

### Enable direct @mentions without making the bot an administrator

The **Group @mentions** guide on **Groups & Members** is available before
and after linking. The bot can remain a regular group member:

1. Open **@BotFather** and send `/setprivacy`.
2. Select your bot and choose **Disable**.
3. Remove the bot from the group, then add it again.
4. Use **Groups & Members → Groups → New** and send the new `/link` command in the group. Wait
   for **Group linked**, then open the group card's pencil icon (**Edit**), choose
   **Recheck bot visibility** and test
   `@your_bot hi` with your actual bot username.

Removing the bot marks the saved RepoDesk group link inactive. Re-adding it in
Telegram does not restore that link; relinking is required even if privacy mode
is already disabled. Inactive group cards show this reminder.

Making the bot a group administrator is an alternative. Message collection is
not required for direct mentions. While privacy mode is enabled, use
`/ask@your_bot hi` or reply to a bot message. See
[Telegram's privacy-mode guide](https://core.telegram.org/bots/features#privacy-mode).
The person sending the group-link command must still be a Telegram group
administrator and an active workspace member.

机器人不会回应其他机器人的命令、机器人作者的消息、匿名发送者或无关群消息。能看到群内机器人回复，不代表已经成为工作区成员。

## Topic 与自然追问

讨论保留在当前群和 Topic，默认仓库选择也独立。Reply 一个保留的机器人回答可以加入该公开讨论。

明确提问得到回答后，在 Telegram 能送达普通消息的前提下，同一成员可在约五分钟内用“再详细点”“换成英文”等清楚追问继续，无需重新 @。其他成员发言不会接管你的讨论。指向别人或无关的消息会结束自动关注。

答案还在生成时、`/recap` 之后、超过窗口或机器人无法判断对象时，重新显式提问或 Reply。群组回答只发送最终结果，不显示私聊式实时预览。

## Use forwarded messages as references

Send `@your_bot save this` (or another clear request), then forward the text,
photo or document within one minute from the same account in the same group and
Topic. When Telegram delivers the forward, the assistant checks whether it supplies
the reference for your request, including while the earlier answer is still being
generated. An answer already in progress may arrive first. Unrelated forwards stay
silent; a forward alone does not start a group conversation.

You can also reply to the forwarded message with `@your_bot save this` or
`/ask@your_bot summarize this`. The reply includes the forwarded content even if
ordinary message collection was disabled. Mentions and commands inside the original
forward are quoted content. The original sender receives no workspace permissions.
Saving still follows your workspace permissions and any required approvals.

## Manage group message collection

Linking or relinking a group enables received-message collection by default.
The link dialog explains this before you send the command, and RepoDesk records
the verified group administrator and time. Collected messages can include people
who are not workspace members and can be used for group context and recaps.
Let group members know the purpose and retention period.

Telegram must deliver the messages first. Disable privacy mode and re-add the bot,
or make it a group administrator, then relink and open the group card's **Edit**
dialog to choose **Recheck bot visibility**.
This refreshes visibility without changing your collection choice. RepoDesk cannot
read messages from before the bot joined or messages Telegram never delivered.

In **Groups & Members**, open the group card's pencil icon (**Edit**) and choose
**Disable message collection**, or send `/capture off`
as a workspace administrator, to stop collecting future ordinary messages.
Directed requests still work. Existing retained data follows the retention policy;
turning collection off does not delete it. Choose **Enable message collection** or
use `/capture on` to turn it back on. Existing groups keep their saved collection
choice until you change it or relink; the new default does not override an opt-out.

## 总结与权限边界

`/recap` 总结当前授权消息。明确“最近七天”“只总结这个 Topic”“列出决策和阻塞”等要求，有助于限定范围。定期总结见 [定时任务与报告](workflows.md)。

群内回答对群成员可见，私聊历史不会带入群中。私有仓库的交互式查询使用私聊；需要在群中发送私有仓库的定期报告，由管理员检查来源、目的地和披露范围后批准。

共享记忆以群和 Topic 隔离，不会因为用户在私聊讲过同一件事就自动公开。详见 [记忆与隐私](memory-and-privacy.md)。
