# 记忆与隐私

For revisioned reference preferences, optional Pi/Codex recall, corrections and
candidate learning, see [source-grounded preferences](preference-memory.md).

RepoDesk 使用对话上下文、历史记忆和经过确认的指令帮助持续协作。它们的用途与删除方式不同。

| 类型 | 用途 | 管理方式 |
| --- | --- | --- |
| 当前对话上下文 | 继续同一 Topic 或 Reply 线程 | 在原对话继续，受来源和保留期限约束 |
| 历史记忆 | 提取已发生的讨论、偏好和未完成事项，按需回忆 | 自然语言查看、记住、忘记、关闭或开启 |
| 持久指令 | 明确要求后续遵循的个人、工作区或任务规则 | Ordinary chat or the panel; saving requires confirmation |
| 技能 | 可发布的团队操作流程 | Skills 中审阅、发布、启用与版本管理 |

## 私聊和群组的边界

私人记忆限定在当前工作区、机器人和本人私聊范围，可跨本人 Topic 使用。群组记忆限定在同一群和 Topic。群组请求不会读取私人历史，群中某个人的说法不会自动成为团队共识。

历史回忆仍会检查当前成员资格、来源保留状态和相关仓库权限。记忆用于参考，不能授权外部写入、批准操作、改变技能或创建定时任务。

## 查看和管理历史记忆

可以直接说：

- “看看你记住了我哪些事情。”
- “记住：这个项目的发布窗口通常是周五下午。”
- “忘记刚才列出的那条发布窗口记忆。”
- “关闭我的长期记忆。”
- “重新开启我的长期记忆。”

需要准确内容时，要求查看原始讨论。忘记请求需要明确对应记录；有多个候选时先定位，不要把模糊表达当作删除全部数据。

个人控制自己的记忆。群成员可添加带说话人归属的记录，并忘记仅包含自己发言的记录；删除混合发言或他人记录、开启或关闭群记忆需要工作区 owner/admin。

关闭会停止该范围的读取和生成，已有记录保留；重新开启后可恢复仍有效的记录。忘记记录不等于删除原始消息，显式历史查询仍是独立功能。

## 自动整理与费用

成功对话闲置后，机器人可在后台提取和整理记忆，默认空闲窗口约三十分钟。后台模型调用计入原请求和工作区预算，所以已完成回复的记录费用可能稍后增加。

记忆会出错，也会受预算和模型质量影响。原始来源变更、过期或权限撤销会使相关记忆失效。长期记忆不延长原消息保留期限，也不用于定时任务。

## 保存持久指令

Ask in ordinary language when you want a future rule:

```text
Always put blockers first in my weekly reports
Show my saved instructions
Replace the weekly-report instruction with: use English and put blockers first
Forget the weekly-report instruction
```

Saving or replacing an instruction requires approval. Private chat saves a personal
instruction; group requests propose a workspace instruction with the corresponding
permissions. Saved instructions are distinct from automatic historical recall.
Reply to a scheduled output and explicitly ask for a rule for future reports to
propose a persistent workflow correction. See [workflows](workflows.md).

## Optional external memory with Nowledge Mem

[Nowledge Mem](nowledge-mem.md) is a separate, optional connection for one selected
member's private chat and Space. Searches send the query to that Mem server;
returned memories can enter the model's authorized context. A direct
`Save to Nowledge Mem: text` request sends the exact text after the colon to Mem.
Chat transcripts are not automatically exported. Disabling internal recall,
forgetting a local memory, disconnecting the plugin or deleting the RepoDesk
workspace does not delete records already saved in Mem. Manage external records
and retention in Mem itself.

## 哪些人和服务能看到数据

- 群内回复对群成员可见，收集开启后可能保留非工作区成员发言。
- 部署管理员及符合条件的工作区 owner/admin 可以在面板查看留存的运行请求、响应和交付内容。
- 模型供应商会接收本次授权的输入与上下文，包括用于处理的图片或提取文字。
- 连接服务会接收其操作所需的数据，例如 Issue 正文或 PR 内容。

应用内加密凭据不代表聊天内容对部署管理员隐藏。不要在对话、附件或技能中放入密钥。供应商的保留与账单政策由相应服务决定，应用删除不能保证清除供应商未提供删除接口的数据。

## 保留与工作区删除

Administrators configure retention in workspace settings and deletion in **Privacy**. Ask “Explain our retention policy” for details. An authorized administrator can ask “Delete this workspace” in private and then confirm the explicit deletion proposal.

删除会清理本地工作区数据及关联任务内容，不会撤回 GitHub 上的提交、PR 或已送达 Telegram 消息。Code Truth 的源码索引与备份副本需要管理员另行清理，参阅 [Code Truth](code-truth.md) 与 [维护指南](maintenance.md)。

不能恢复机器人从未收到的 Telegram 历史。任务历史入口与来源一同受保留策略约束，不是永久归档服务。
