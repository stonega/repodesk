# 自动代码审查：Review Bot

Review Bot 在 GitHub 上审查所连接仓库的 PR，也可以回答评论中的问题、按明确要求修复同一 PR。它使用现有 GitHub App、Codex runner 和模型认证，不需要再注册一个机器人。

## 配置前提

- 已连接 [GitHub App 和目标仓库](github.md)。
- [Codex](codex.md) 已启用，runner、任务镜像及模型认证可用。
- RepoDesk 有公开 HTTPS 地址，GitHub 能投递 webhook。

默认任务镜像包含审查所需的 Open Code Review 工具。自定义任务镜像需保留该工具；缺少时会明确失败。

## 管理员：启用审查

1. 打开 **Plugins → Review Bot**。
2. 检查 **Webhook secret**。通过当前 RepoDesk 创建的 App 通常已保存；旧 App 若缺失，配置或生成 secret，并在 GitHub 设置相同值。
3. 在 GitHub App 的 webhook 设置中核对页面显示的 URL、secret 和启用状态，订阅 `pull_request`、`issue_comment`、`pull_request_review_comment`。
4. 在 **Configuration → Edit** 设置自动审查、评论请求、明确请求的修复和审查模型，保存后启用。

在公开 HTTPS 站点创建的新 App 会预填 webhook。若创建时使用 localhost，上线后需要把未启用的占位地址改为真实地址。保存 RepoDesk secret 不会替你修改 GitHub。

配置对插件统一生效，没有额外仓库名单。避免在多个工作区对同一 App/仓库启用 Review Bot，确保事件路由清楚。

## 自动审查

新建、重新打开、推送新 commit、从草稿标为可审查等事件会触发审查；自动跳过草稿 PR。新 commit 会取代旧 commit 的待完成自动审查。关闭 PR 会取消待处理工作。

结果是绑定具体 commit 的信息性审查，包含摘要和可定位的问题；不会代替人工批准或自动合并。查看它实际审查、跳过或无法覆盖的文件，不要将无发现视为无缺陷证明。

自动审查基于管理员启用的 App installation 授权。成员评论请求另外检查成员身份和 GitHub 权限。

## 在 GitHub 评论中使用

使用插件页面显示的实际 App bot 名称。以下 `repodesk` 仅为示例：

| 评论 | 结果 |
| --- | --- |
| `@repodesk[bot] review` | 审查当前 PR |
| `@repodesk[bot] explain this finding` | 解释发现的问题 |
| `@repodesk[bot] fix this` | 实现明确要求、运行检查并更新同一 PR |
| `@repodesk[bot] status` | 查看已确认状态 |
| `@repodesk[bot] cancel` | 请求停止活动任务 |

`@repodesk` 简写也受支持。提及放在一行开头，代码块或引用中的提及不会授权工作。回复行内审查意见时，可以将原意见作为参考。

评论用户需是活跃成员，已通过 Telegram `/github` 验证身份，并有当前仓库读权限；修复需写权限且管理员已启用 requested fixes。普通问题保持只读。必要的澄清由原请求者再次 @回复继续。

## 修复范围

同仓库 PR 支持检查后更新原分支，fork PR 支持审查和问答。明确修复请求可启动任务，无需再次点击开发批准；不包含合并或部署授权。

其他维护者推送更新时，尚未发布的工作会重新核对当前代码，避免覆盖新提交。发布结果不确定时先检查 GitHub。停止、移除授权和删除工作区都不会撤回已发出的评论或提交。

未收到结果时，依次检查 GitHub webhook delivery、插件状态、成员验证和 runner 状态，参阅 [排障指南](troubleshooting.md)。
