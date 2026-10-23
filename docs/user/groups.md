# 群组与话题

将机器人关联到群组后，成员可以在群内提问、总结和安排定时报告。群组加入、消息可见性、收集许可与工作区成员权限分别管理。

## Link a group

1. Add your bot to the intended Telegram group.
2. In the admin panel, open **Group access → New** and copy the complete command.
3. Send `/link@your_bot TOKEN` in that group within ten minutes, using an active
   workspace member account that is also a Telegram group administrator.
4. Wait for **Group linked**. The panel updates automatically while the dialog is
   open, or when you return to the page. Test `/ask@your_bot hi` in the group.

The workspace's deployment operator can generate the token without verifying a
personal Telegram identity. Workspace owner/admin panel accounts can also generate
it. A token links one group once; it does not grant membership or an admin role.
Invite the person sending it through **Members & access** first if needed.

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

机器人不会回应其他机器人的命令、机器人作者的消息、匿名发送者或无关群消息。能看到群内机器人回复，不代表已经成为工作区成员。

## Topic 与自然追问

讨论保留在当前群和 Topic，默认仓库选择也独立。Reply 一个保留的机器人回答可以加入该公开讨论。

明确提问得到回答后，在 Telegram 能送达普通消息的前提下，同一成员可在约五分钟内用“再详细点”“换成英文”等清楚追问继续，无需重新 @。其他成员发言不会接管你的讨论。指向别人或无关的消息会结束自动关注。

答案还在生成时、`/recap` 之后、超过窗口或机器人无法判断对象时，重新显式提问或 Reply。群组回答只发送最终结果，不显示私聊式实时预览。

## 开启群消息收集

默认仅以明确发给机器人的消息为上下文。完整群聊总结还需要：

1. 按团队需要配置 Telegram 可见性，例如授予机器人管理员身份或关闭 BotFather 隐私模式。
2. 在 **Group access** 检查实际可见性。
3. 告知群成员收集范围、用途和保留期限。
4. Have an administrator send `/capture on` in the group, or choose **Enable
   message collection** in **Group access**. Once enabled, the same button becomes
   **Disable message collection** to stop collecting ordinary group messages.

只有机器人收到且获准保留的消息能用于总结，包括非工作区成员的发言。Telegram 可见性与 RepoDesk 收集许可两者都需满足；仅关闭隐私模式不会自动开启收集。无法获取机器人加入前的旧历史。

发送 `/capture off` 停止后续普通消息收集，已有留存数据继续按保留策略管理；关闭不等于删除。

## 总结与权限边界

`/recap` 总结当前授权消息。明确“最近七天”“只总结这个 Topic”“列出决策和阻塞”等要求，有助于限定范围。定期总结见 [定时任务与报告](workflows.md)。

群内回答对群成员可见，私聊历史不会带入群中。私有仓库的交互式查询使用私聊；需要在群中发送私有仓库的定期报告，由管理员检查来源、目的地和披露范围后批准。

共享记忆以群和 Topic 隔离，不会因为用户在私聊讲过同一件事就自动公开。详见 [记忆与隐私](memory-and-privacy.md)。
