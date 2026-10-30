# Telegram 使用指南

在私聊中直接描述问题；在群里使用命令、@提及或回复机器人。管理员负责部署和连接服务，普通成员可以从加入工作区开始。

## 第一次使用

1. 获取管理员的邀请链接，打开后发送 Start；或点击 **Request access** 等待审批。
2. 发送 `/help` 查看帮助。
3. 加入多个工作区时，用 `/workspace <工作区 UUID>` 选择本次使用的工作区。
4. 发送问题，例如“帮我整理一下这段需求”，或在已连接 GitHub 后查询仓库。

如果收到设置未完成的提示，联系管理员检查激活状态；成员加入不会自动启用机器人。

## 私聊与 Topic

使用 Telegram 原生 Topic 整理不同讨论。同一 Topic 内直接发消息即可继续，无需每次 Reply；不同 Topic 有独立的默认上下文，回复和预览保留在原 Topic。

While the bot is answering, send additional details directly. Messages from you
in the same conversation join the active response at the next generation boundary;
the final answer incorporates them. Supported files, recordings and private
forwarded references can also supply additional input. An already running external
operation may finish before a correction is read. Stop remains available.

Outside Topics, standalone messages start new conversations once the answer has
finished. Use Telegram **Reply** to continue a retained user message or bot answer.
Replying to an older message continues its latest conversation state. An unavailable
anchor starts a new conversation with a brief explanation.

Ordinary answers appear without quoting your message. The bot can attach a native
reply when emphasizing a specific message or its wording. Commands, approvals and
Codex task messages retain their own controls and reply behavior.

你可以问“我们之前讨论的登录方案是什么？”来查询自己在当前工作区保留的私聊历史。群组请求无法读取这些私聊。长对话会整理和压缩上下文；需要准确原文时，可明确要求查找原始讨论。

## Emoji reactions

The bot can occasionally react to your current message with a native emoji such
as 👍, ❤️ or 🎉, in private chats and linked groups/Topics. It chooses reactions
to suit the conversation and still sends its normal reply. You can ask it to skip
reactions or to use a particular supported emoji for the current message.

Reactions depend on Telegram's chat permissions and available emoji. If a reaction
cannot be applied, the ordinary reply can still arrive. A reaction does not approve
an action or indicate task progress or completion. Scheduled reports do not react
to previous messages.

## 选择仓库

发送 `/repos`，点击仓库按钮；超过前十项时用 `/repos 仓库名` 搜索。选中项有标记，**Clear selection** 清除默认仓库。

选择仅作用于你在当前工作区、机器人、聊天和 Topic 中的请求。消息中明确命名的仓库优先，其他成员和 Topic 不受影响。选择不会改动已有任务的目标，也不代表批准写入。

群组选择器只显示公共仓库，私有仓库的交互查询使用私聊。仓库不在列表时，核对 [GitHub 连接和权限](github.md)。

## 可直接尝试的请求

| 目标 | 示例 |
| --- | --- |
| 查看仓库进展 | “列出 example/app 当前未合并的 PR，附上负责人和链接。” |
| 对比 PR | “比较 example/app 的 PR #12 和 #15 的实现及审查意见。” |
| 查代码 | “example/app 在哪里校验登录状态？给出文件位置。”（需要 Code Truth） |
| 创建 Issue | “在 example/app 创建登录超时问题的 Issue，复现步骤是……” |
| 实现修改 | “在 example/app 修复登录错误提示，并补上检查。”（需要 Codex 和 GitHub 写权限） |
| 查看交接 | “昨天做到哪里了，哪些任务等我回答或审核？” |
| 定期报告 | “每天 09:00 Asia/Taipei 发一份 example/app 的 PR 报告。” |

明确仓库、期望结果和限制条件，有助于减少必要澄清。查询或解释请求不会授权修改；需要确认的操作会展示具体目标和内容。

## 阅读网页

直接发送公开网页链接并说明任务，例如“阅读 https://example.com，整理重点并附上来源链接”。
内置网页阅读工具无需配置、API Key 或启用搜索，也可用于已授权的定时任务。它会提取正文为 Markdown，保留标题、作者、发布日期和最终来源网址。

网页搜索仍需在 [Model settings](configuration.md#聊天网页搜索) 中选择搜索服务；直接阅读链接不受搜索开关影响。
仅支持公开 HTML 网页，无法登录、执行页面 JavaScript、绕过付费墙或读取内网及 PDF 链接。长网页最多提取 24,000 字符，结果会标明截断；不要发送带密钥、私人内容或签名令牌的网址。

## 图片与附件

可发送图片、UTF-8 文本/代码文件和带可选取文字的 PDF。图片可以没有说明；发起开发任务时仍应在文字中说明希望完成的修改。

| 输入 | 限制 |
| --- | --- |
| JPEG、PNG、GIF、WebP 图片 | 单张最多 5 MiB；聊天模型需支持图片 |
| UTF-8 文本和代码文件 | 单个最多 256 KiB，提取文字最多 32,000 字符 |
| 未加密、可选取文字的 PDF | 最多 5 MiB、40 页、32,000 个提取字符 |
| 一次请求涉及的附件 | 最多四个，下载总量最多 10 MiB，当前输入优先 |

扫描 PDF 可将相关页面作为图片发送。语音、音频、视频、压缩包和 Office 文档不支持解析。超限文件不会静默截断，按提示缩小范围后重发。相册图片作为独立消息处理，不会自动合并成一个请求。

群内附件需要在说明文字中使用命令或 @提及，或直接回复机器人。无需把 API Key、Bot Token 等凭据发给机器人。

## 查看进度和停止

普通私聊执行时显示原生 **Thinking…** 预览，生成过程中逐步更新，最终回复可能与预览不同。短回复可能直接完成；群组和定时输出只显示最终答案。

- `/status`：查看当前聊天或 Topic 的请求，多个候选时选择。回复具体任务消息发送此命令，可帮助定位。
- 原生 **Stop**：停止对应私聊生成；已经转交给 Codex 时也会停止关联任务。
- `/cancel`：停止当前或所选请求/任务；也可用任务消息上的 **Cancel**。

“Stopping…” 表示已记录停止请求，等待确认结束。已发消息、PR 和正在进行的外部写入可能无法撤回。结果不确定时先检查目标服务。

Codex 的补充需求、持续对话和 **View conversation** 详见 [Codex 开发任务](codex.md)。任务按钮使用最新消息，旧按钮可能已失效。

## 确认操作

Issue、PR 合并/关闭、定时任务和持久指令等会显示 **Approve / Reject**。核对目标、完整内容、接收位置和时区后确认。通常只有请求本人可以确认，提案在 15 分钟后过期。

清晰的 Codex 修改请求采用任务授权流程，通过检查后自动发布 PR，不要求额外点击一次开发批准。合并、部署和其他超出该任务的操作仍需各自授权。

继续阅读 [命令参考](commands.md)、[群组与话题](groups.md)、[记忆与隐私](memory-and-privacy.md)。
