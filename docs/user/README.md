# RepoDesk 用户文档

RepoDesk 是一个自托管的 Telegram AI 助手，让你在聊天中查询 GitHub 仓库、了解 Issue 和 PR、提交经过确认的操作，以及交给 Codex 实现修改。

第一次部署，从 [Get started：快速开始](get-started.md) 阅读。已经加入团队，直接看 [Telegram 使用指南](telegram-experience.md)。

## 部署与管理

| 文档 | 你可以完成什么 |
| --- | --- |
| [快速开始](get-started.md) | 用 Docker 启动服务，配置模型和机器人，收到第一条回复 |
| [公开部署与 HTTPS](deployment.md) | 配置服务器、域名、webhook 和任务记录入口 |
| [模型与配置](configuration.md) | 选择模型供应商，设置预算、超时和可选服务 |
| [工作区与成员](administration.md) | 邀请成员，管理角色、GitHub 身份和访问权限 |
| [备份、升级与恢复](maintenance.md) | 备份数据和密钥，升级服务，处理故障恢复 |
| [常见问题与排障](troubleshooting.md) | 排查不回复、连接失败、预算和发布问题 |

## Telegram 日常使用

| 文档 | 你可以完成什么 |
| --- | --- |
| [Voice notes and audio](audio.md) | Enable local Qwen3-ASR transcription and send recordings |
| [Telegram 使用指南](telegram-experience.md) | 开始对话，使用 Topic、附件、状态和停止操作 |
| [命令参考](commands.md) | 查询命令格式、用途和使用条件 |
| [群组与话题](groups.md) | 关联群组，控制消息收集，在群内协作 |
| [定时任务与报告](workflows.md) | 创建定期总结或仓库报告，调整输出和暂停任务 |
| [技能与可复用流程](skills.md) | 保存、导入、发布和启用团队技能 |
| [记忆与隐私](memory-and-privacy.md) | 管理历史记忆、持久指令和数据保留 |

## GitHub 与集成

| 文档 | 你可以完成什么 |
| --- | --- |
| [连接和使用 GitHub](github.md) | 连接仓库和个人账号，查询 PR，创建 Issue，确认 PR 操作 |
| [代码问答：Code Truth](code-truth.md) | 为选定仓库建立源码索引，获取带代码位置的回答 |
| [Codex 开发任务](codex.md) | 配置执行环境，发起修改，补充需求并查看 PR |
| [自动代码审查：Review Bot](review-bot.md) | 自动审查 PR，在 GitHub 评论中提问或请求修复 |
| [Google](google-workspace.md) | 配置共用 Web application，由成员在 Telegram 连接自己的 Google 账号 |
| [Obsidian organization notes](obsidian.md) | Manage shared notes, linked knowledge, tasks and native vault import/export |
| [Google Search Console](search-console.md) | 查询选定资源的搜索表现、Sitemap 与 URL 索引状态 |
| [Cloudflare](cloudflare.md) | 查询流量、DNS、Workers、存储与安全资源；经确认修改 DNS、缓存、设置和路由 |

## 使用范围

当前版本面向自托管试用；首次使用请先用测试机器人和测试仓库验证自己的模型、权限和交付流程。可用功能取决于部署版本、已连接的服务和工作区设置。RepoDesk 不提供预先连接的公共机器人。

仓库查询受工作区和 GitHub 权限约束；Code Truth、Codex 和 Review Bot 需要额外配置。Telegram 只能提供机器人实际收到的消息，不能导入任意聊天或加入前的历史。AI 回答和代码审查需要结合引用、检查结果和人工判断使用。
